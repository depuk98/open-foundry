/**
 * Tests for GrpcNerExtractor — EntityExtractor implementation.
 */

import { describe, it, expect } from 'vitest';
import { GrpcNerExtractor } from '../grpc-extractor.js';
import type { ExtractEntitiesResponse, NerGrpcClient } from '../ner-grpc-client.js';

function createMockClient(
  response?: Partial<ExtractEntitiesResponse>,
  shouldThrow = false,
): NerGrpcClient {
  return {
    extractEntities: async () => {
      if (shouldThrow) throw new Error('gRPC failed');
      return {
        entities: [],
        metadata: {
          glinerCount: 0, flairCount: 0, conflicts: 0, llmReviewed: 0, finalCount: 0,
          stage1LatencyMs: 0, stage3LatencyMs: 0, llmInvoked: false,
          glinerAvailable: true, flairAvailable: true,
        },
        ...response,
      };
    },
    shutdown: () => {},
  } as unknown as NerGrpcClient;
}

describe('GrpcNerExtractor', () => {
  const labels = ['Person', 'Organization', 'Location', 'Equipment', 'MilitaryUnit'];

  it('implements EntityExtractor interface', () => {
    const client = createMockClient();
    const extractor = new GrpcNerExtractor(client, labels);
    expect(extractor.name).toBe('grpc-gliner-flair');
    expect(typeof extractor.extract).toBe('function');
  });

  it('extracts entities via gRPC', async () => {
    const client = createMockClient({
      entities: [
        { text: 'Bakhmut', type: 'Location', confidence: 0.97, context: 'near Bakhmut', status: 1 },
        { text: 'T-90M', type: 'Equipment', confidence: 0.88, context: 'T-90M tanks', status: 3 },
        { text: 'Putin', type: 'Person', confidence: 0.95, context: 'Putin met', status: 1 },
      ],
    });

    const extractor = new GrpcNerExtractor(client, labels);
    const entities = await extractor.extract('Putin met near Bakhmut, T-90M tanks spotted');

    expect(entities.length).toBe(3);
    expect(entities[0]!.name).toBe('Bakhmut');
    expect(entities[0]!.type).toBe('Location');
    expect(entities[0]!.confidence).toBeCloseTo(0.97);
    expect(entities[1]!.name).toBe('T-90M');
    expect(entities[1]!.type).toBe('Equipment');
    expect(entities[2]!.name).toBe('Putin');
    expect(entities[2]!.type).toBe('Person');
  });

  it('passes labels to client', async () => {
    let receivedLabels: string[] = [];
    const client = createMockClient();
    client.extractEntities = async (req: any) => {
      receivedLabels = req.labels;
      return { entities: [], metadata: { glinerCount: 0, flairCount: 0, conflicts: 0, llmReviewed: 0, finalCount: 0, stage1LatencyMs: 0, stage3LatencyMs: 0, llmInvoked: false, glinerAvailable: true, flairAvailable: true } };
    };

    const customLabels = ['Equipment', 'WeaponSystem', 'MilitaryUnit', 'ArmedGroup'];
    const extractor = new GrpcNerExtractor(client, customLabels);
    await extractor.extract('T-90M spotted');

    expect(receivedLabels).toEqual(customLabels);
  });

  it('returns empty array on gRPC failure', async () => {
    const client = createMockClient(undefined, true);
    const extractor = new GrpcNerExtractor(client, labels);
    const entities = await extractor.extract('Test text');

    expect(entities).toEqual([]);
    // Should not throw — critical for pipeline resilience
  });

  it('returns empty array on empty entities response', async () => {
    const client = createMockClient({ entities: [] });
    const extractor = new GrpcNerExtractor(client, labels);
    const entities = await extractor.extract('Test text');

    expect(entities).toEqual([]);
  });

  it('returns empty array on undefined entities', async () => {
    const client = createMockClient({ entities: undefined as any });
    const extractor = new GrpcNerExtractor(client, labels);
    const entities = await extractor.extract('Test text');

    expect(entities).toEqual([]);
  });

  it('handles all 9 entity types', async () => {
    const client = createMockClient({
      entities: [
        { text: 'Zelensky', type: 'Person', confidence: 0.9, context: '', status: 1 },
        { text: 'NATO', type: 'Organization', confidence: 0.85, context: '', status: 1 },
        { text: 'Kyiv', type: 'Location', confidence: 0.97, context: '', status: 1 },
        { text: 'T-90M', type: 'Equipment', confidence: 0.88, context: '', status: 3 },
        { text: 'HIMARS', type: 'WeaponSystem', confidence: 0.86, context: '', status: 3 },
        { text: '4th Guards Tank Div', type: 'MilitaryUnit', confidence: 0.91, context: '', status: 3 },
        { text: 'Wagner', type: 'ArmedGroup', confidence: 0.82, context: '', status: 4 },
        { text: 'Donbas', type: 'ConflictZone', confidence: 0.85, context: '', status: 3 },
        { text: 'G7 Summit', type: 'Event', confidence: 0.88, context: '', status: 1 },
      ],
    });

    const extractor = new GrpcNerExtractor(client, [
      'Person', 'Organization', 'Location', 'Equipment',
      'WeaponSystem', 'MilitaryUnit', 'ArmedGroup', 'ConflictZone', 'Event',
    ]);
    const entities = await extractor.extract('Complex text');

    expect(entities.length).toBe(9);
    const types = entities.map(e => e.type);
    expect(types).toContain('Person');
    expect(types).toContain('WeaponSystem');
    expect(types).toContain('MilitaryUnit');
    expect(types).toContain('ArmedGroup');
    expect(types).toContain('ConflictZone');
    expect(types).toContain('Event');
  });

  it('enables LLM review by default', async () => {
    let capturedEnableLlm: boolean | undefined;
    const client = createMockClient();
    client.extractEntities = async (req: any) => {
      capturedEnableLlm = req.enableLlmReview;
      return { entities: [], metadata: { glinerCount: 0, flairCount: 0, conflicts: 0, llmReviewed: 0, finalCount: 0, stage1LatencyMs: 0, stage3LatencyMs: 0, llmInvoked: false, glinerAvailable: true, flairAvailable: true } };
    };

    const extractor = new GrpcNerExtractor(client, labels);
    await extractor.extract('Test');

    expect(capturedEnableLlm).toBe(true);
  });

  it('returns empty array for empty text', async () => {
    const client = createMockClient();
    const extractor = new GrpcNerExtractor(client, labels);
    const entities = await extractor.extract('');

    expect(entities).toEqual([]);
  });
});
