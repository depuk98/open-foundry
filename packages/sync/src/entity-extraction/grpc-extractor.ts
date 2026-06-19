/**
 * GrpcNerExtractor — EntityExtractor implementation that delegates to the
 * Python NER gRPC service (three-stage pipeline: GLiNER + Flair + LLM).
 *
 * If the gRPC call fails for any reason, returns an empty array — never throws.
 * The CompositeExtractor will fall through to the next extractor (WinkExtractor).
 */

import { NerGrpcClient, type ExtractEntitiesResponse } from './ner-grpc-client.js';
import type { EntityExtractor, ExtractedEntity } from './types.js';

export class GrpcNerExtractor implements EntityExtractor {
  readonly name = 'grpc-gliner-flair';

  constructor(
    private client: NerGrpcClient,
    private labels: string[],
    private minConfidence = 0.4,
  ) {}

  async extract(text: string): Promise<ExtractedEntity[]> {
    try {
      const response: ExtractEntitiesResponse = await this.client.extractEntities({
        text,
        labels: this.labels,
        minConfidence: this.minConfidence,
        maxEntities: 20,
        enableLlmReview: true,
      });

      if (!response.entities || response.entities.length === 0) {
        return [];
      }

      return response.entities.map((e) => ({
        type: e.type,
        name: e.text,
        confidence: e.confidence,
        context: e.context,
      }));
    } catch (err) {
      // gRPC failure — return empty, composite will fall through to fallback
      return [];
    }
  }
}
