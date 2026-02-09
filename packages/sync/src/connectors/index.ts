/**
 * Connector types and implementations.
 */

// Interface and types
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
} from "./connector.js";

// Implementations
export { JdbcConnector } from "./jdbc-connector.js";
