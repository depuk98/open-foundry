/**
 * Entity extraction module — NER pipeline for OSINT ingestion.
 */

export type {
  ExtractedEntity,
  EntityExtractor,
  EntityExtractionResult,
  EntityExtractionConfig,
} from './types.js';

export { WinkExtractor } from './wink-extractor.js';
export { GazetteerExtractor } from './gazetteer-extractor.js';
export { CompositeExtractor } from './composite-extractor.js';
export { EntityDedupCache } from './entity-dedup.js';
export { EntityExtractionService } from './entity-extraction-service.js';
export { GrpcNerExtractor } from './grpc-extractor.js';
