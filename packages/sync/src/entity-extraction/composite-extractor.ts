import type { EntityExtractor, ExtractedEntity } from './types.js';

/**
 * Runs multiple extractors and merges results.
 * Deduplicates across extractors (same name + same type → keep highest confidence).
 */
export class CompositeExtractor implements EntityExtractor {
  readonly name = 'composite';

  constructor(private extractors: EntityExtractor[]) {}

  async extract(text: string): Promise<ExtractedEntity[]> {
    const allResults = await Promise.all(
      this.extractors.map(async (extractor) => {
        try {
          return await extractor.extract(text);
        } catch (err) {
          console.error(`[ner] Extractor '${extractor.name}' failed:`, err);
          return [];
        }
      }),
    );

    const merged = new Map<string, ExtractedEntity>();

    for (const results of allResults) {
      for (const entity of results) {
        const key = `${entity.type}:${entity.name.toLowerCase()}`;
        const existing = merged.get(key);
        if (!existing || entity.confidence > existing.confidence) {
          merged.set(key, entity);
        }
      }
    }

    return [...merged.values()];
  }
}
