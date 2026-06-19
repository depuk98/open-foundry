/**
 * Core types for the entity extraction module.
 */

/** A single entity extracted from text. */
export interface ExtractedEntity {
  /** Ontology type: 'Person', 'Organization', 'Location', 'Equipment' */
  type: string;
  /** The extracted entity name (e.g., "Zelensky", "Bakhmut", "T-90M") */
  name: string;
  /** Surrounding text context (~50 chars) */
  context?: string;
  /** Confidence score 0.0-1.0 */
  confidence: number;
}

/** Contract for any NER implementation. */
export interface EntityExtractor {
  /** Human-readable name for logging/metrics */
  readonly name: string;
  /** Extract entities from raw text. Returns empty array on failure. */
  extract(text: string): Promise<ExtractedEntity[]>;
}

/** Result of processing one report through entity extraction. */
export interface EntityExtractionResult {
  entitiesExtracted: number;
  entitiesCreated: number;
  entitiesDedupHit: number;
  linksCreated: number;
  errors: number;
  entitiesRejected: number;
}

/** Configuration for entity extraction from connector YAML. */
export interface EntityExtractionConfig {
  enabled: boolean;
  types?: string[];
  minConfidence?: number;
  maxEntitiesPerReport?: number;
  minTextLength?: number;
  validation?: ValidationConfig;
}

/** Per-connector validation configuration. */
export interface ValidationConfig {
  enabled: boolean;
  clean?: {
    stripPossessive?: boolean;
    stripTrailingPunct?: boolean;
    stripEmoji?: boolean;
    stripQuotes?: boolean;
    normalizeWhitespace?: boolean;
    stripHashtag?: boolean;
  };
  rules?: {
    person?: string[];
    organization?: string[];
    equipment?: string[];
    location?: string[];
  };
}
