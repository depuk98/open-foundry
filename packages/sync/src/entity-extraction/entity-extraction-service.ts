import type { StorageProvider, RequestContext } from '@openfoundry/spi';
import type { EntityExtractor, EntityExtractionResult, ExtractedEntity, ValidationConfig } from './types.js';
import { EntityDedupCache } from './entity-dedup.js';
import { validateEntity } from './entity-validation.js';
import { normalizeForDedup } from './dedup-utils.js';

interface EntityCreateResult {
  _id: string;
}

interface ObjectManagerLike {
  create(type: string, props: Record<string, unknown>, ctx: RequestContext): Promise<EntityCreateResult>;
}

interface LinkManagerLike {
  createLink(
    linkType: string,
    fromId: string,
    toId: string,
    properties: Record<string, unknown>,
    ctx: RequestContext,
  ): Promise<unknown>;
}

/**
 * Remove entities whose name is a whole-word substring of another same-type entity
 * from the same extraction batch. Keeps the longer span.
 * Uses word boundaries so "US" is NOT removed by "Russia" or "Eva" by "Evan".
 *
 * O(n²) time complexity — caller must bound input via slice(0, maxEntities).
 * At n=20 (default cap), this is 400 comparisons — acceptable.
 */
function deduplicateOverlappingSpans(entities: ExtractedEntity[], maxInput = 200): ExtractedEntity[] {
  if (entities.length > maxInput) entities = entities.slice(0, maxInput);
  return entities.filter((entity, i) =>
    !entities.some((other, j) =>
      i !== j &&
      entity.type === other.type &&
      isWordOrBoundarySubstring(entity.name, other.name)
    )
  );
}

function isWordOrBoundarySubstring(shorter: string, longer: string): boolean {
  if (longer.length <= shorter.length) return false;
  const escaped = shorter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`\\b${escaped}\\b`, 'i');
  return regex.test(longer);
}

/**
 * Orchestrates the full entity extraction pipeline:
 * extract → dedup → create/lookup entity → create Mentions* link.
 *
 * Failures are per-entity — one bad entity doesn't block others.
 */
export class EntityExtractionService {
  constructor(
    private extractor: EntityExtractor,
    private dedupCache: EntityDedupCache,
    private objectManager: ObjectManagerLike,
    private linkManager: LinkManagerLike,
    private storage: StorageProvider,
    private config: { minConfidence: number; maxEntities: number; minTextLength: number } = {
      minConfidence: 0.6, maxEntities: 20, minTextLength: 30,
    },
    private validationConfig?: ValidationConfig,
  ) {}

  async processReport(
    reportId: string,
    text: string,
    ctx: RequestContext,
  ): Promise<EntityExtractionResult> {
    const result: EntityExtractionResult = {
      entitiesExtracted: 0,
      entitiesCreated: 0,
      entitiesDedupHit: 0,
      linksCreated: 0,
      errors: 0,
      entitiesRejected: 0,
    };

    if (!text || text.trim().length < this.config.minTextLength) {
      return result;
    }

    let entities: Awaited<ReturnType<EntityExtractor['extract']>>;
    try {
      entities = await this.extractor.extract(text);
    } catch {
      result.errors++;
      return result;
    }

    entities = entities
      .filter((e) => e.confidence >= this.config.minConfidence)
      .slice(0, this.config.maxEntities);

    // Remove intra-text substring overlaps before dedup/storage.
    // "Gen Keane" + "Keane" from same tweet → keep only "Gen Keane".
    entities = deduplicateOverlappingSpans(entities, this.config.maxEntities * 2);

    result.entitiesExtracted = entities.length;

    // Batch resolve all entities against the dedup cache + DB.
    // Reduces cold-start DB load from N queries to ≤4 (one per table).
    const dedupResults = await this.dedupCache.batchResolve(
      entities.map(e => ({ type: e.type, name: e.name })),
      this.storage,
      ctx,
    );

    for (const entity of entities) {
      try {
        // Validate and clean entity before storage
        const validation = validateEntity(entity, text, this.validationConfig);
        if (!validation.valid) {
          result.entitiesRejected++;
          continue;
        }
        const cleanEntity = validation.entity;

        const dedupKey = `${cleanEntity.type}:${normalizeForDedup(cleanEntity.type, cleanEntity.name)}`;
        let entityId = dedupResults.get(dedupKey) ?? null;

        if (!entityId) {
          const created = await this.createEntity(cleanEntity, ctx);
          if (created) {
            entityId = created;
            this.dedupCache.set(cleanEntity.type, cleanEntity.name, entityId);
            result.entitiesCreated++;
          }
        } else {
          result.entitiesDedupHit++;
        }

        if (entityId) {
          const linkType = this.linkTypeFor(cleanEntity.type);
          await this.linkManager.createLink(
            linkType, reportId, entityId,
            { context: cleanEntity.context, confidence: cleanEntity.confidence },
            ctx,
          );
          result.linksCreated++;
        }
      } catch {
        result.errors++;
      }
    }

    return result;
  }

  private async createEntity(
    entity: { type: string; name: string },
    ctx: RequestContext,
  ): Promise<string | null> {
    const now = new Date().toISOString();
    const base = {
      createdAt: now,
      createdBy: 'ner-pipeline',
      updatedAt: now,
      updatedBy: 'ner-pipeline',
    };
    const normalizedName = normalizeForDedup(entity.type, entity.name);

    switch (entity.type) {
      case 'Person': {
        const created = await this.objectManager.create('Person', {
          ...base,
          fullName: entity.name,
          _normalizedName: normalizedName,
          watchlistStatus: 'NONE',
          isPersonOfInterest: false,
        }, ctx);
        return created._id;
      }
      case 'Organization':
      case 'MilitaryUnit': {
        const created = await this.objectManager.create('Organization', {
          ...base,
          name: entity.name,
          _normalizedName: normalizedName,
          type: entity.type === 'MilitaryUnit' ? 'MILITARY_UNIT' : 'OTHER',
          isDesignated: false,
        }, ctx);
        return created._id;
      }
      case 'ArmedGroup': {
        const created = await this.objectManager.create('Organization', {
          ...base,
          name: entity.name,
          _normalizedName: normalizedName,
          type: 'ARMED_GROUP',
          isDesignated: false,
        }, ctx);
        return created._id;
      }
      case 'Location':
      case 'ConflictZone': {
        const created = await this.objectManager.create('Location', {
          ...base,
          name: entity.name,
          _normalizedName: normalizedName,
          type: 'CITY',
          country: 'UNKNOWN',
          status: entity.type === 'ConflictZone' ? 'CONTESTED' : 'UNKNOWN',
        }, ctx);
        return created._id;
      }
      case 'Equipment':
      case 'WeaponSystem': {
        const created = await this.objectManager.create('Equipment', {
          ...base,
          designation: entity.name,
          _normalizedName: normalizedName,
          category: 'OTHER',
        }, ctx);
        return created._id;
      }
      case 'Event': {
        const created = await this.objectManager.create('Event', {
          ...base,
          eventDate: now,
          _normalizedName: normalizedName,
          type: 'OTHER',
          description: `NER-extracted event: ${entity.name}`,
          locationName: 'UNKNOWN',
          country: 'UNKNOWN',
        }, ctx);
        return created._id;
      }
      default:
        return null;
    }
  }

  private linkTypeFor(entityType: string): string {
    switch (entityType) {
      case 'Person': return 'MentionsPerson';
      case 'Organization': return 'MentionsOrganization';
      case 'Location': return 'MentionsLocation';
      case 'Equipment': return 'MentionsEquipment';
      // Mapped types — stored in existing tables, linked via standard Mentions*
      case 'WeaponSystem': return 'MentionsEquipment';
      case 'MilitaryUnit': return 'MentionsOrganization';
      case 'ArmedGroup': return 'MentionsOrganization';
      case 'ConflictZone': return 'MentionsLocation';
      // Event uses ReportedEvent (different semantics — the report "reports" the event)
      case 'Event': return 'ReportedEvent';
      default: throw new Error(`Unknown entity type: ${entityType}`);
    }
  }
}
