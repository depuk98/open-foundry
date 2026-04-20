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
import { parseOdl } from '@openfoundry/odl';
import type { ParsedSchema, ObjectType, LinkType } from '@openfoundry/odl';
import type { OntologySchema, ObjectTypeDefinition, LinkTypeDefinition, PropertyDefinition, IndexDefinition } from '@openfoundry/spi';

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
  // Simple YAML parsing — pack.yaml uses flat key: value and lists
  return parseSimpleYaml(content);
}

/**
 * Minimal YAML parser for pack.yaml files.
 * Handles: scalars, flat objects, and arrays of strings.
 * Does NOT handle nested objects, multi-line strings, or anchors.
 */
function parseSimpleYaml(content: string): PackManifest {
  const result: Record<string, unknown> = {};
  const lines = content.split('\n');
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const line of lines) {
    // Skip comments and empty lines
    if (line.trim().startsWith('#') || line.trim() === '') continue;

    // List item (indented with -)
    const listMatch = line.match(/^\s+-\s+(.+)/);
    if (listMatch?.[1] && currentKey && currentList) {
      currentList.push(listMatch[1].trim());
      continue;
    }

    // Key-value or key with nested content
    const kvMatch = line.match(/^(\w+):\s*(.*)/);
    if (kvMatch?.[1]) {
      // Save previous list
      if (currentKey && currentList) {
        result[currentKey] = currentList;
        currentList = null;
      }

      const key = kvMatch[1];
      const value = (kvMatch[2] ?? '').trim();

      if (value === '' || value === '>') {
        // Start of a list or block
        currentKey = key;
        currentList = [];
      } else {
        // Scalar value
        currentKey = null;
        currentList = null;
        // Remove surrounding quotes
        result[key] = value.replace(/^["']|["']$/g, '');
      }
      continue;
    }

    // Indented key-value (for nested objects like dependencies/provides)
    const nestedMatch = line.match(/^\s+(\S+):\s*(.*)/);
    if (nestedMatch?.[1] && currentKey) {
      const nestedKey = nestedMatch[1];
      const nestedVal = (nestedMatch[2] ?? '').trim().replace(/^["']|["']$/g, '');
      if (currentList) {
        // Was expecting a list but got a nested object — switch
        const obj = (result[currentKey] as Record<string, string>) ?? {};
        obj[nestedKey] = nestedVal;
        result[currentKey] = obj;
        currentList = null;
      } else {
        const obj = ((result[currentKey] ?? {}) as Record<string, string>);
        obj[nestedKey] = nestedVal;
        result[currentKey] = obj;
      }
    }
  }

  // Save final list
  if (currentKey && currentList) {
    result[currentKey] = currentList;
  }

  return result as unknown as PackManifest;
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

  // Load each pack
  const parsedSchemas: ParsedSchema[] = [];
  const manifests: PackManifest[] = [];

  for (const name of names) {
    const packDir = resolve(dir, name);
    if (!existsSync(resolve(packDir, 'pack.yaml'))) {
      console.warn(`Schema loader: pack '${name}' not found at ${packDir}, skipping`);
      continue;
    }

    const manifest = readManifest(packDir);
    manifests.push(manifest);

    const odlSource = loadPackOdl(packDir, manifest);
    if (odlSource.trim()) {
      const parsed = parseOdl(odlSource);
      parsedSchemas.push(parsed);
    }
  }

  const merged = mergeSchemas(parsedSchemas);
  const spiSchema = toOntologySchema(merged);

  return { parsed: merged, spiSchema, packs: manifests };
}
