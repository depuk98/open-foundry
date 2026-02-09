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

// Identity resolution (MVP 4.4.2)
export type {
  QualityViolation,
  IdentityConflictEvent,
  IdentityStore,
  QuarantineInput,
  QuarantineRecord,
  QuarantineQueryFilter,
  IdentityResolutionResult,
  IdentityResolverConfig,
} from "./identity.js";

export { IdentityResolver, QuarantineQueue } from "./identity.js";
