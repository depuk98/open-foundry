/**
 * Maps ODL/SPI property types to PostgreSQL column types.
 */

const ODL_TO_PG: Record<string, string> = {
  // Scalars
  String: 'TEXT',
  Int: 'INTEGER',
  Float: 'DOUBLE PRECISION',
  Boolean: 'BOOLEAN',
  ID: 'TEXT',

  // Date/time
  DateTime: 'TIMESTAMPTZ',
  Date: 'DATE',
  Time: 'TIME',
  Duration: 'INTERVAL',

  // JSON / untyped
  JSON: 'JSONB',

  // NHS-specific scalars mapped to TEXT (stored as validated strings)
  NHSNumber: 'TEXT',
  ODS: 'TEXT',
  SNOMED: 'TEXT',
  Email: 'TEXT',
  Phone: 'TEXT',
  URL: 'TEXT',
  Markdown: 'TEXT',
};

/**
 * Convert an ODL/SPI property type name to a PostgreSQL column type.
 * Unknown types default to TEXT (enum types, custom scalars).
 */
export function pgType(odlType: string): string {
  return ODL_TO_PG[odlType] ?? 'TEXT';
}

/**
 * Convert an SPI IndexType to PostgreSQL index method.
 */
export function pgIndexMethod(indexType: string): string {
  switch (indexType) {
    case 'BTREE':
      return 'btree';
    case 'HASH':
      return 'hash';
    case 'GIN':
      return 'gin';
    case 'GIST':
      return 'gist';
    case 'FULLTEXT':
      return 'gin'; // GIN with tsvector for full-text search
    default:
      return 'btree';
  }
}

/**
 * Sanitize an identifier for PostgreSQL (lowercase snake_case, quoted if needed).
 */
export function pgIdent(name: string): string {
  // Convert PascalCase/camelCase to snake_case
  const snake = name
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
  // Quote to avoid reserved word conflicts
  return `"${snake}"`;
}

/**
 * Create an unquoted snake_case version for use in index/constraint names.
 */
export function snakeCase(name: string): string {
  return name
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}
