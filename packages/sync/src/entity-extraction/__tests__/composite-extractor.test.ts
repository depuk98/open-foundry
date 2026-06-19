import { describe, it, expect } from 'vitest';
import { CompositeExtractor } from '../composite-extractor.js';
import type { EntityExtractor, ExtractedEntity } from '../types.js';

class MockExtractor implements EntityExtractor {
  readonly name: string;
  private entities: ExtractedEntity[];
  constructor(name: string, entities: ExtractedEntity[]) {
    this.name = name;
    this.entities = entities;
  }
  async extract(_text: string): Promise<ExtractedEntity[]> { return this.entities; }
}

class FailingExtractor implements EntityExtractor {
  readonly name = 'failing';
  async extract(_text: string): Promise<ExtractedEntity[]> {
    throw new Error('NER crash');
  }
}

describe('CompositeExtractor', () => {
  it('merges results from multiple extractors', async () => {
    const e1 = new MockExtractor('e1', [
      { type: 'Person', name: 'Zelensky', confidence: 0.9 },
    ]);
    const e2 = new MockExtractor('e2', [
      { type: 'Location', name: 'Bakhmut', confidence: 0.92 },
    ]);
    const composite = new CompositeExtractor([e1, e2]);
    const result = await composite.extract('Zelensky visited Bakhmut');
    expect(result.length).toBe(2);
    expect(result.some((r) => r.type === 'Person' && r.name === 'Zelensky')).toBe(true);
    expect(result.some((r) => r.type === 'Location' && r.name === 'Bakhmut')).toBe(true);
  });

  it('deduplicates same name+type keeping highest confidence', async () => {
    const e1 = new MockExtractor('e1', [
      { type: 'Person', name: 'Putin', confidence: 0.7 },
    ]);
    const e2 = new MockExtractor('e2', [
      { type: 'Person', name: 'Putin', confidence: 0.95 },
    ]);
    const composite = new CompositeExtractor([e1, e2]);
    const result = await composite.extract('Putin spoke');
    expect(result.length).toBe(1);
    expect(result[0]!.confidence).toBe(0.95);
  });

  it('handles extractor failures gracefully', async () => {
    const e1 = new MockExtractor('e1', [
      { type: 'Organization', name: 'NATO', confidence: 0.85 },
    ]);
    const composite = new CompositeExtractor([e1, new FailingExtractor()]);
    const result = await composite.extract('NATO summit');
    expect(result.length).toBe(1);
    expect(result[0]!.name).toBe('NATO');
  });

  it('returns empty array when all extractors fail', async () => {
    const composite = new CompositeExtractor([new FailingExtractor(), new FailingExtractor()]);
    const result = await composite.extract('anything');
    expect(result).toEqual([]);
  });

  it('returns empty array for no extractors', async () => {
    const composite = new CompositeExtractor([]);
    const result = await composite.extract('anything');
    expect(result).toEqual([]);
  });
});
