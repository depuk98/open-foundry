/**
 * Domain pack schema loader.
 *
 * Reads pack.yaml manifests from domain pack directories, loads ODL schema
 * files, parses them with the ODL compiler, and produces both a ParsedSchema
 * (for the engine/GraphQL layer) and an OntologySchema (for the SPI storage layer).
 *
 * Configuration via environment variables:
 *   DOMAIN_PACKS_DIR  — path to domain-packs directory (default: auto-detected from monorepo)
 *   DOMAIN_PACKS      — comma-separated pack names to load (default: all found; 'core' always included)
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { parseOdl } from '@openfoundry/odl';
import type { ParsedSchema, ObjectType, LinkType } from '@openfoundry/odl';
import { parseActionManifest } from '@openfoundry/actions';
import { logger } from './logger.js';
import type { ActionManifest } from '@openfoundry/actions';
import type { OntologySchema, ObjectTypeDefinition, LinkTypeDefinition, PropertyDefinition, IndexDefinition } from '@openfoundry/spi';
import type { FieldPermissionConfig } from '@openfoundry/security';
import type { ManifestRegistry } from './graphql/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PackManifest {
  name: string;
  version: string;
  namespace: string;
  description?: string;
  dependencies?: Record<string, string>;
  schema?: string[];
  actions?: string[];
  connectors?: string[];
  permissions?: string[];
}

export interface LoadedSchema {
  /** Combined ParsedSchema for engine + GraphQL layers. */
  parsed: ParsedSchema;
  /** OntologySchema for storage.applySchema(). */
  spiSchema: OntologySchema;
  /** Pack manifests that were loaded. */
  packs: PackManifest[];
  /** Action manifests (ManifestRegistry for action executor). */
  manifestRegistry: ManifestRegistry;
  /** Field permission configurations for field-level redaction. */
  fieldPermissions: FieldPermissionConfig[];
}

// ---------------------------------------------------------------------------
// Pack discovery
// ---------------------------------------------------------------------------

/**
 * Resolve the domain-packs directory.
 * Tries DOMAIN_PACKS_DIR env var first, then walks up from this file to find
 * the monorepo root (where domain-packs/ lives).
 */
function resolvePacksDir(): string {
  if (process.env['DOMAIN_PACKS_DIR']) {
    return process.env['DOMAIN_PACKS_DIR'];
  }

  // Walk up from packages/api/src/ → packages/api/ → packages/ → root
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const monorepoRoot = resolve(thisDir, '..', '..', '..');
  const packsDir = resolve(monorepoRoot, 'domain-packs');

  if (existsSync(packsDir)) {
    return packsDir;
  }

  // Docker/production layout: /app/domain-packs
  if (existsSync('/app/domain-packs')) {
    return '/app/domain-packs';
  }

  throw new Error(
    'Cannot find domain-packs directory. Set DOMAIN_PACKS_DIR or ensure the monorepo layout is intact.',
  );
}

/**
 * Discover available pack names in the domain-packs directory.
 */
function discoverPacks(packsDir: string): string[] {
  return readdirSync(packsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(resolve(packsDir, d.name, 'pack.yaml')))
    .map(d => d.name);
}

// ---------------------------------------------------------------------------
// Pack loading
// ---------------------------------------------------------------------------

/**
 * Read and parse a pack.yaml manifest.
 */
function readManifest(packDir: string): PackManifest {
  const yamlPath = resolve(packDir, 'pack.yaml');
  const content = readFileSync(yamlPath, 'utf-8');
  const parsed = parseYaml(content);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid pack.yaml at ${yamlPath}: expected an object`);
  }
  return parsed as unknown as PackManifest;
}

/**
 * Load ODL source from a single domain pack.
 * Reads all schema files listed in pack.yaml, concatenates them,
 * and strips duplicate namespace directives (keeping only the first).
 */
function loadPackOdl(packDir: string, manifest: PackManifest): string {
  const schemaFiles = manifest.schema ?? [];
  if (schemaFiles.length === 0) return '';

  const sources = schemaFiles.map(f => readFileSync(resolve(packDir, f), 'utf-8'));

  // Keep namespace directive only from the first file
  const first = sources[0];
  const rest = sources.slice(1).map(s =>
    s.replace(/^extend schema @namespace\([^)]+\)\s*/m, ''),
  );
  return [first, ...rest].join('\n\n');
}

/**
 * Load action YAML manifests from a domain pack.
 * Parses each file listed in pack.yaml actions: and adds valid manifests to the map.
 *
 * Structural validation is strict (invalid manifests are fatal).
 * Schema cross-reference validation is handled separately post-merge:
 * the loadDomainPacks function verifies every @actionType has a manifest.
 */
function loadPackActions(
  packDir: string,
  manifest: PackManifest,
  manifests: Map<string, ActionManifest>,
): void {
  const actionFiles = manifest.actions ?? [];
  for (const file of actionFiles) {
    const filePath = resolve(packDir, file);
    if (!existsSync(filePath)) {
      logger.warn(`Schema loader: action file '${file}' not found in ${packDir}, skipping`);
      continue;
    }
    const yamlContent = readFileSync(filePath, 'utf-8');
    // Structural validation only — cross-ref checked post-merge
    const result = parseActionManifest(yamlContent);
    if (result.valid && result.manifest) {
      manifests.set(result.manifest.action, result.manifest);
    } else {
      // Structural errors are fatal — manifest must parse correctly
      const errors = result.errors.map(e => e.message).join('; ');
      throw new Error(`Schema loader: action manifest '${file}' is invalid: ${errors}`);
    }
  }
}

/**
 * Load field permission configurations from a domain pack.
 * Looks for permissions/field-permissions.yaml in the pack directory.
 */
function loadPackFieldPermissions(
  packDir: string,
  _manifest: PackManifest,
  configs: FieldPermissionConfig[],
): void {
  const filePath = resolve(packDir, 'permissions', 'field-permissions.yaml');
  if (!existsSync(filePath)) return;

  const content = readFileSync(filePath, 'utf-8');
  const parsed = parseYaml(content);
  if (!Array.isArray(parsed)) return;

  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const objectType = e['objectType'];
    const alwaysVisible = Array.isArray(e['alwaysVisible']) ? e['alwaysVisible'] as string[] : [];
    const fieldsByRelation: Record<string, string[]> = {};

    if (e['fieldsByRelation'] && typeof e['fieldsByRelation'] === 'object') {
      for (const [relation, fields] of Object.entries(e['fieldsByRelation'] as Record<string, unknown>)) {
        if (Array.isArray(fields)) {
          fieldsByRelation[relation] = fields as string[];
        }
      }
    }

    if (typeof objectType === 'string') {
      configs.push({ objectType, alwaysVisible, fieldsByRelation });
    }
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate field permission configs against the merged schema.
 * Warns on invalid object types or field names to catch config drift early.
 */
function validateFieldPermissions(
  configs: FieldPermissionConfig[],
  schema: ParsedSchema,
): void {
  const objectTypes = new Map(schema.objectTypes.map(o => [o.name, o]));

  for (const config of configs) {
    const objType = objectTypes.get(config.objectType);
    if (!objType) {
      logger.warn(
        `Field permissions: unknown object type "${config.objectType}". ` +
        `Known types: ${[...objectTypes.keys()].join(', ')}`,
      );
      continue;
    }

    // Collect stored field names (excluding @link, @computed, @primary)
    const storedFields = new Set<string>();
    for (const field of objType.fields) {
      if (field.directives.some(d => d.kind === 'primary')) {
        storedFields.add('id'); // primary maps to 'id' in API
        continue;
      }
      if (field.directives.some(d => d.kind === 'link' || d.kind === 'computed')) continue;
      storedFields.add(field.name);
    }

    // Validate alwaysVisible
    for (const f of config.alwaysVisible) {
      if (f !== 'id' && !storedFields.has(f)) {
        logger.warn(
          `Field permissions [${config.objectType}]: alwaysVisible field "${f}" not in schema. ` +
          `Valid: ${[...storedFields].join(', ')}`,
        );
      }
    }

    // Validate fieldsByRelation
    for (const [relation, fields] of Object.entries(config.fieldsByRelation)) {
      for (const f of fields) {
        if (!storedFields.has(f)) {
          logger.warn(
            `Field permissions [${config.objectType}].${relation}: field "${f}" not in schema. ` +
            `Valid: ${[...storedFields].join(', ')}`,
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Schema merging
// ---------------------------------------------------------------------------

/**
 * Merge multiple ParsedSchemas into one combined schema.
 * Later packs override earlier ones on name conflicts.
 */
function mergeSchemas(schemas: ParsedSchema[]): ParsedSchema {
  const merged: ParsedSchema = {
    objectTypes: [],
    linkTypes: [],
    actionTypes: [],
    enums: [],
    interfaces: [],
    scalars: [],
  };

  const seenObjects = new Set<string>();
  const seenLinks = new Set<string>();
  const seenEnums = new Set<string>();
  const seenInterfaces = new Set<string>();
  const seenScalars = new Set<string>();

  for (const schema of schemas) {
    for (const obj of schema.objectTypes) {
      if (!seenObjects.has(obj.name)) {
        merged.objectTypes.push(obj);
        seenObjects.add(obj.name);
      }
    }
    for (const link of schema.linkTypes) {
      if (!seenLinks.has(link.name)) {
        merged.linkTypes.push(link);
        seenLinks.add(link.name);
      }
    }
    for (const action of schema.actionTypes) {
      merged.actionTypes.push(action);
    }
    for (const e of schema.enums) {
      if (!seenEnums.has(e.name)) {
        merged.enums.push(e);
        seenEnums.add(e.name);
      }
    }
    for (const iface of schema.interfaces) {
      if (!seenInterfaces.has(iface.name)) {
        merged.interfaces.push(iface);
        seenInterfaces.add(iface.name);
      }
    }
    for (const scalar of schema.scalars) {
      if (!seenScalars.has(scalar.name)) {
        merged.scalars.push(scalar);
        seenScalars.add(scalar.name);
      }
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// ParsedSchema → OntologySchema conversion
// ---------------------------------------------------------------------------

/** Map ODL FieldTypeRef.name to SPI property type (capitalized for pgType compatibility). */
function mapFieldType(typeName: string): string {
  // ODL uses GraphQL scalar names which are already capitalized
  // and match what pgType() expects.
  return typeName;
}

/**
 * Convert a ParsedSchema ObjectType to an SPI ObjectTypeDefinition.
 * Strips the 'id' field (handled by system columns) and extracts indexes.
 */
function convertObjectType(objType: ObjectType): ObjectTypeDefinition {
  const properties: PropertyDefinition[] = [];
  const indexes: IndexDefinition[] = [];

  for (const field of objType.fields) {
    // Skip 'id' — handled as system column _id
    if (field.directives.some(d => d.kind === 'primary')) continue;
    // Skip computed fields — not stored
    if (field.directives.some(d => d.kind === 'computed')) continue;
    // Skip @link virtual fields — resolved at query time
    if (field.directives.some(d => d.kind === 'link')) continue;

    properties.push({
      name: field.name,
      type: mapFieldType(field.type.name),
      required: field.type.nonNull,
    });

    // Extract index definitions from directives
    const hasUnique = field.directives.some(d => d.kind === 'unique');
    const hasIndexed = field.directives.some(d => d.kind === 'indexed');
    const hasSearchable = field.directives.some(d => d.kind === 'searchable');

    if (hasUnique) {
      indexes.push({ field: field.name, indexType: 'BTREE', unique: true });
    } else if (hasIndexed) {
      indexes.push({ field: field.name, indexType: 'BTREE' });
    }
    if (hasSearchable) {
      indexes.push({ field: field.name, indexType: 'FULLTEXT' });
    }
  }

  return {
    name: objType.name,
    properties,
    indexes: indexes.length > 0 ? indexes : undefined,
  };
}

/**
 * Convert a ParsedSchema LinkType to an SPI LinkTypeDefinition.
 */
function convertLinkType(linkType: LinkType): LinkTypeDefinition {
  const properties: PropertyDefinition[] = linkType.fields.map(f => ({
    name: f.name,
    type: mapFieldType(f.type.name),
    required: f.type.nonNull,
  }));

  return {
    name: linkType.name,
    fromType: linkType.from,
    toType: linkType.to,
    cardinality: linkType.cardinality,
    properties: properties.length > 0 ? properties : undefined,
  };
}

/**
 * Convert a ParsedSchema to an OntologySchema suitable for storage.applySchema().
 */
function toOntologySchema(parsed: ParsedSchema): OntologySchema {
  return {
    version: 1,
    objectTypes: parsed.objectTypes.map(convertObjectType),
    linkTypes: parsed.linkTypes.map(convertLinkType),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load domain pack schemas from the filesystem.
 *
 * @param packsDir - Optional override for domain-packs directory
 * @param packNames - Optional list of pack names. If omitted, loads all packs found.
 *                    'core' is always loaded first regardless.
 */
export async function loadDomainPacks(
  packsDir?: string,
  packNames?: string[],
): Promise<LoadedSchema> {
  const dir = packsDir ?? resolvePacksDir();

  // Determine which packs to load
  let names: string[];
  if (packNames && packNames.length > 0) {
    names = packNames;
  } else {
    names = discoverPacks(dir);
  }

  // Ensure 'core' is loaded first
  names = names.filter(n => n !== 'core');
  if (existsSync(resolve(dir, 'core', 'pack.yaml'))) {
    names = ['core', ...names];
  }

  // Phase 1: Load ODL schemas and field permissions from all packs
  const parsedSchemas: ParsedSchema[] = [];
  const manifests: PackManifest[] = [];
  const packDirs: string[] = [];
  const fieldPermissions: FieldPermissionConfig[] = [];

  for (const name of names) {
    const packDir = resolve(dir, name);
    if (!existsSync(resolve(packDir, 'pack.yaml'))) {
      logger.warn(`Schema loader: pack '${name}' not found at ${packDir}, skipping`);
      continue;
    }

    const manifest = readManifest(packDir);
    manifests.push(manifest);
    packDirs.push(packDir);

    const odlSource = loadPackOdl(packDir, manifest);
    if (odlSource.trim()) {
      try {
        const parsed = parseOdl(odlSource);
        parsedSchemas.push(parsed);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Schema loader: failed to parse ODL from pack '${name}': ${msg}`);
      }
    }

    // Load field permission configurations
    loadPackFieldPermissions(packDir, manifest, fieldPermissions);
  }

  const merged = mergeSchemas(parsedSchemas);
  const spiSchema = toOntologySchema(merged);

  // Phase 2: Load action manifests (structural validation only — cross-ref checked in Phase 3)
  const actionManifests = new Map<string, ActionManifest>();
  for (let i = 0; i < manifests.length; i++) {
    loadPackActions(packDirs[i]!, manifests[i]!, actionManifests);
  }

  // Phase 3: Validate all schema-defined actionTypes have matching manifests (fail-closed)
  const missingManifests: string[] = [];
  for (const actionType of merged.actionTypes) {
    if (!actionManifests.has(actionType.name)) {
      missingManifests.push(actionType.name);
    }
  }
  if (missingManifests.length > 0) {
    throw new Error(
      `Schema loader: actionTypes defined in ODL but missing YAML manifests: ${missingManifests.join(', ')}. ` +
      `Each @actionType must have a corresponding action manifest.`,
    );
  }

  // Phase 4: Validate field permissions against merged schema
  validateFieldPermissions(fieldPermissions, merged);

  // Build a ManifestRegistry from loaded action manifests
  const manifestRegistry: ManifestRegistry = {
    get(actionName: string) { return actionManifests.get(actionName); },
  };

  return { parsed: merged, spiSchema, packs: manifests, manifestRegistry, fieldPermissions };
}
