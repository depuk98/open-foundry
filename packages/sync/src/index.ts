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
