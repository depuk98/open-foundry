/**
 * @openfoundry/storage-postgres
 *
 * PostgreSQL 17 + Apache AGE 1.5 storage provider for Open Foundry.
 * Provides schema management, DDL generation, object CRUD, and transactions.
 */

// ─── Schema / DDL ───
export {
  generateDDL,
  generateObjectTableDDL,
  generateLinkTableDDL,
  generateAllGraphDDL,
  generateGraphSetupDDL,
  generateNodeLabelDDL,
  generateEdgeLabelDDL,
  generateAuditDDL,
  generateLineageDDL,
  pgType,
  pgIdent,
  snakeCase,
  pgIndexMethod,
} from './schema/index.js';

export type {
  DDLGenerationOptions,
  GeneratedDDL,
} from './schema/index.js';

// ─── Object CRUD ───
export {
  createObject,
  getObject,
  updateObject,
  softDeleteObject,
  hardDeleteObject,
  queryObjects,
  filterToSql,
} from './objects/index.js';

export type { SqlFragment } from './objects/index.js';

// ─── Transactions ───
export { PgTransaction, resolveQueryable } from './transactions/index.js';
export type { Queryable } from './transactions/index.js';
