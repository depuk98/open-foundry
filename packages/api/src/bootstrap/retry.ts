/**
 * Retry wrapper for EntityExtractor calls.
 *
 * Retries on errors with exponential backoff. Does NOT retry on empty
 * results — an empty result is valid, not a failure. Also skips retry
 * for INVALID_ARGUMENT gRPC status (bad input won't improve).
 */
import type { EntityExtractor, ExtractedEntity } from '@openfoundry/sync';

export async function withRetry(
  extractor: EntityExtractor,
  text: string,
  maxAttempts = 3,
  baseDelayMs = 1000,
): Promise<ExtractedEntity[]> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await extractor.extract(text);
      return result;
    } catch (err) {
      // Skip retry for INVALID_ARGUMENT (bad input won't improve on retry)
      const grpcStatus = (err as { code?: number })?.code;
      if (grpcStatus === 3) break; // INVALID_ARGUMENT

      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, baseDelayMs * attempt));
      }
    }
  }

  return [];
}
