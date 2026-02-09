/**
 * @openfoundry/sync - Sync Engine
 *
 * Source-system connectors and synchronization infrastructure
 * for the Open Foundry platform (Spec Section 6).
 */

// Connector interface and types
export type {
  Connector,
  ConnectorConfig,
  Checkpoint,
  ExtractOptions,
  SourceRecord,
  SourceSchema,
  SourceTableSchema,
  SourceColumnSchema,
  WritebackRecord,
  WritebackResult,
} from "./connectors/index.js";

// Connector implementations
export { JdbcConnector } from "./connectors/index.js";

// Mapping types and parser (Section 6.3)
export type {
  TransformFn,
  SyncMode,
  ConflictResolution,
  RateLimitConfig,
  SyncConfig,
  ConnectionConfig,
  PrimaryKeyMapping,
  PropertyMapping,
  LinkKeyMapping,
  LinkMapping,
  ObjectMapping,
  DatasourceMappingConfig,
  MappedObject,
  MappedLink,
} from "./mapping/index.js";

// Mapping implementations
export {
  concat,
  prefix,
  suffix,
  parseDate,
  parseDateTime,
  toUpper,
  toLower,
  trim,
  ifPresent,
  coalesce,
  map,
  custom,
  registerCustomTransform,
  clearCustomTransforms,
  parseTransformExpression,
  parseMappingConfig,
  RecordMapper,
  createRecordMapper,
} from "./mapping/index.js";
