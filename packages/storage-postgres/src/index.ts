/**
 * @openfoundry/storage-postgres
 *
 * PostgreSQL 17 + Apache AGE 1.5 storage provider for Open Foundry.
 * This package provides schema management and DDL generation.
 */

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
