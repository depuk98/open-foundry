/**
 * NER (Named Entity Recognition) pipeline bootstrap.
 *
 * Initializes the three-tier NER pipeline for extracting Person, Organization,
 * Location, Equipment, and other OSINT entity types from IntelReport content.
 * Best-effort — failures never block report storage.
 *
 * Primary: Python gRPC sidecar (GLiNER + Flair + phi4-mini LLM).
 * Fallback: compromise inline JS (WinkExtractor + Gazetteer).
 */
import type { EntityExtractor } from '@openfoundry/sync';
import { withRetry } from './retry.js';

interface NerBootstrapDeps {
  objectManager: unknown;
  linkManager: unknown;
  storage: unknown;
  logger: { info: (msg: string) => void; warn: (data: object, msg: string) => void };
}

export async function initializeNerPipeline(deps: NerBootstrapDeps): Promise<unknown> {
  const { existsSync } = await import('node:fs');
  const { join, resolve } = await import('node:path');
  const nerModule = await import('@openfoundry/sync');

  const {
    GrpcNerExtractor, WinkExtractor, GazetteerExtractor,
    CompositeExtractor, EntityDedupCache, EntityExtractionService,
  } = nerModule;

  const nerLabels = [
    'Person', 'Organization', 'Location',
    'Equipment', 'WeaponSystem', 'MilitaryUnit',
    'ArmedGroup', 'ConflictZone', 'Event',
  ];

  // Primary: Python gRPC NER service (three-stage: GLiNER + Flair + phi4-mini)
  const grpcAddress = process.env['NER_SERVICE_URL'] ?? 'localhost:50052';
  const grpcClient = 'NerGrpcClient' in nerModule
    ? new nerModule.NerGrpcClient({ address: grpcAddress })
    : null;
  const grpcExtractor = grpcClient ? new GrpcNerExtractor(grpcClient, nerLabels, 0.4) : null;

  // Fallback: compromise inline JS
  const winkExtractor = new WinkExtractor(0.6);

  // Equipment gazetteer as supplement to compromise fallback
  const gazetteerPath = resolve(
    process.env['DOMAIN_PACKS_DIR'] ?? join(process.cwd(), 'domain-packs'),
    'osint', 'entity-extraction', 'equipment-gazetteer.yaml',
  );
  let gazetteerExtractor: InstanceType<typeof GazetteerExtractor> | null = null;
  if (existsSync(gazetteerPath)) {
    try {
      gazetteerExtractor = new GazetteerExtractor(gazetteerPath);
    } catch (err) {
      deps.logger.warn({ err }, 'NER: failed to load equipment gazetteer');
    }
  }

  // Fallback-aware extractor: tries gRPC first. Falls back to compromise
  // only if gRPC returns empty or is unavailable.
  const fallbackExtractor: EntityExtractor = {
    name: 'gRPC-primary-with-fallback',
    async extract(text: string) {
      if (grpcExtractor) {
        const result = await withRetry(grpcExtractor, text);
        if (result.length > 0) return result;
      }
      const winkResult = await winkExtractor.extract(text);
      const gazResult = gazetteerExtractor ? await gazetteerExtractor.extract(text) : [];
      return [...winkResult, ...gazResult];
    },
  };

  const compositeExtractor = new CompositeExtractor([fallbackExtractor]);
  const entityDedupCache = new EntityDedupCache(10000);

  const entityExtractionService = new EntityExtractionService(
    compositeExtractor,
    entityDedupCache,
    deps.objectManager as any,
    deps.linkManager as any,
    deps.storage as any,
    { minConfidence: 0.4, maxEntities: 20, minTextLength: 30 },
    { enabled: true },
  );
  deps.logger.info('NER: entity extraction pipeline initialized');
  return entityExtractionService;
}
