import nlp from 'compromise';
import type { EntityExtractor, ExtractedEntity } from './types.js';

/**
 * NER extractor using compromise — Person, Organization, Location detection.
 * Pure JavaScript, ~200KB, zero network calls.
 *
 * Uses compromise's built-in named entity recognition which classifies
 * proper nouns as people, organizations, and places.
 */
export class WinkExtractor implements EntityExtractor {
  readonly name = 'ner-compromise';

  constructor(private minConfidence = 0.6) {}

  async extract(text: string): Promise<ExtractedEntity[]> {
    const doc = nlp(text);

    const people = doc.people().out('array') as string[];
    const orgs = doc.organizations().out('array') as string[];
    const places = doc.places().out('array') as string[];

    const entities: ExtractedEntity[] = [];

    for (const name of people) {
      const normalized = this.normalizeName(name, 'Person');
      if (normalized.length >= 2) {
        entities.push({
          type: 'Person',
          name: normalized,
          context: this.extractContext(text, name),
          confidence: this.computeConfidence(normalized),
        });
      }
    }

    for (const name of orgs) {
      const normalized = this.normalizeName(name, 'Organization');
      if (normalized.length >= 2) {
        entities.push({
          type: 'Organization',
          name: normalized,
          context: this.extractContext(text, name),
          confidence: this.computeConfidence(normalized),
        });
      }
    }

    for (const name of places) {
      const normalized = this.normalizeName(name, 'Location');
      if (normalized.length >= 2 && !this.isCommonWord(normalized)) {
        entities.push({
          type: 'Location',
          name: normalized,
          context: this.extractContext(text, name),
          confidence: this.computeConfidence(normalized),
        });
      }
    }

    return entities
      .filter((e) => e.confidence >= this.minConfidence)
      .filter((e, i, arr) => this.isUnique(e, i, arr));
  }

  private normalizeName(name: string, type: string): string {
    let result = name.trim();
    // Remove trailing punctuation
    result = result.replace(/[.,;:!?]+$/, '');
    if (type === 'Person') {
      result = result.replace(/^(President|General|Minister|Secretary|Dr\.|Mr\.|Ms\.|Admiral|Colonel|Captain|Major|Lieutenant)\s+/i, '').trim();
    }
    return result;
  }

  private computeConfidence(name: string): number {
    // Longer names and multi-word names are more likely to be real entities
    if (name.length > 15) return 0.9;
    if (name.includes(' ')) return 0.85;
    if (name.length > 5) return 0.8;
    if (name.length > 3) return 0.7;
    return 0.5;
  }

  private isCommonWord(name: string): boolean {
    const commonWords = new Set([
      'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can',
      'had', 'her', 'was', 'one', 'our', 'out', 'has', 'have', 'from',
      'they', 'this', 'that', 'with', 'have', 'will', 'your', 'which',
      'their', 'them', 'would', 'about', 'there', 'been', 'were',
      'when', 'what', 'said', 'could', 'also', 'into', 'more', 'some',
      'than', 'then', 'other', 'these', 'those', 'after', 'before',
    ]);
    return commonWords.has(name.toLowerCase());
  }

  private extractContext(text: string, name: string): string {
    const idx = text.indexOf(name);
    if (idx === -1) return '';
    const start = Math.max(0, idx - 25);
    const end = Math.min(text.length, idx + name.length + 25);
    return text.slice(start, end).trim();
  }

  private isUnique(entity: ExtractedEntity, index: number, arr: ExtractedEntity[]): boolean {
    return arr.findIndex((e: ExtractedEntity) => e.name === entity.name && e.type === entity.type) === index;
  }
}
