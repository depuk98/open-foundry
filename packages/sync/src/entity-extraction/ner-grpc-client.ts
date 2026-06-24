/**
 * gRPC client for the NER service sidecar.
 *
 * Mirrors packages/actions/src/cel/client.ts pattern exactly.
 * Uses @grpc/grpc-js + @grpc/proto-loader for dynamic proto loading.
 * The proto definition lives in packages/ner-service/proto/ner.proto.
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Proto loading types (dynamic from @grpc/proto-loader)
// ---------------------------------------------------------------------------

interface ProtoExtractRequest {
  text: string;
  labels: string[];
  min_confidence?: number;
  max_entities?: number;
  enable_llm_review?: boolean;
}

interface ProtoEntity {
  text: string;
  type: string;
  confidence: number;
  context: string;
  status: number;
}

interface ProtoPipelineMetadata {
  gliner_count: number;
  flair_count: number;
  conflicts: number;
  llm_reviewed: number;
  final_count: number;
  stage1_latency_ms: number;
  stage3_latency_ms: number;
  llm_invoked: boolean;
  gliner_available: boolean;
  flair_available: boolean;
}

interface ProtoExtractResponse {
  entities: ProtoEntity[];
  metadata: ProtoPipelineMetadata;
}

interface NerServiceClient {
  ExtractEntities(
    request: ProtoExtractRequest,
    metadata: grpc.Metadata,
    options: { deadline: Date },
    callback: (error: grpc.ServiceError | null, response: ProtoExtractResponse) => void,
  ): void;
}

// ---------------------------------------------------------------------------
// Proto path resolution
// ---------------------------------------------------------------------------

function defaultProtoPath(): string {
  const currentDir = typeof __dirname !== 'undefined'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));
  return resolve(currentDir, '..', '..', '..', 'ner-service', 'proto', 'ner.proto');
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

class CircuitBreaker {
  private state = CircuitState.CLOSED;
  private failureCount = 0;
  private lastFailureTime = 0;

  constructor(
    private readonly threshold: number,
    private readonly resetMs: number,
  ) {}

  get isOpen(): boolean {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.lastFailureTime >= this.resetMs) {
        this.state = CircuitState.HALF_OPEN;
        return false;
      }
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.failureCount = 0;
    this.state = CircuitState.CLOSED;
  }

  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.threshold) {
      this.state = CircuitState.OPEN;
    }
  }
}

// ---------------------------------------------------------------------------
// Retry helpers
// ---------------------------------------------------------------------------

function retryDelay(attempt: number, baseMs: number): number {
  return Math.min(baseMs * Math.pow(2, attempt - 1), 5000);
}

const RETRYABLE_CODES: Set<number> = new Set([
  grpc.status.UNAVAILABLE,
  grpc.status.DEADLINE_EXCEEDED,
  grpc.status.RESOURCE_EXHAUSTED,
]);

// ---------------------------------------------------------------------------
// NerGrpcClient
// ---------------------------------------------------------------------------

export interface ExtractEntitiesRequest {
  text: string;
  labels: string[];
  minConfidence?: number;
  maxEntities?: number;
  enableLlmReview?: boolean;
}

export interface ExtractEntitiesResponse {
  entities: Array<{
    text: string;
    type: string;
    confidence: number;
    context: string;
    status: number;
  }>;
  metadata: {
    glinerCount: number;
    flairCount: number;
    conflicts: number;
    llmReviewed: number;
    finalCount: number;
    stage1LatencyMs: number;
    stage3LatencyMs: number;
    llmInvoked: boolean;
    glinerAvailable: boolean;
    flairAvailable: boolean;
  };
}

export interface NerGrpcClientOptions {
  address?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  protoPath?: string;
}

export class NerGrpcClient {
  private client: NerServiceClient | null = null;
  private readonly address: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly protoPath: string;
  private readonly circuitBreaker: CircuitBreaker;

  constructor(options: NerGrpcClientOptions = {}) {
    this.address = options.address ?? process.env['NER_SERVICE_URL'] ?? 'localhost:50052';
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 100;
    this.protoPath = options.protoPath ?? defaultProtoPath();
    this.circuitBreaker = new CircuitBreaker(5, 30000);
  }

  private deadline(): Date {
    return new Date(Date.now() + this.timeoutMs);
  }

  private connect(): NerServiceClient {
    if (this.client) {
      return this.client;
    }

    const packageDefinition = protoLoader.loadSync(this.protoPath, {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });

    const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
    const nerPackage = protoDescriptor['ner'] as { v1: { NerService: grpc.ServiceClientConstructor } };

    this.client = new nerPackage.v1.NerService(
      this.address,
      grpc.credentials.createInsecure(), // Internal Docker network only — TLS not required
    ) as unknown as NerServiceClient;

    return this.client;
  }

  extractEntities(request: ExtractEntitiesRequest): Promise<ExtractEntitiesResponse> {
    if (this.circuitBreaker.isOpen) {
      return Promise.reject(new Error('Circuit breaker is open — NER service unavailable'));
    }

    const protoRequest: ProtoExtractRequest = {
      text: request.text,
      labels: request.labels,
      min_confidence: request.minConfidence,
      max_entities: request.maxEntities,
      enable_llm_review: request.enableLlmReview,
    };

    return this.executeWithRetry(protoRequest, 0);
  }

  private executeWithRetry(
    request: ProtoExtractRequest,
    attempt: number,
  ): Promise<ExtractEntitiesResponse> {
    return new Promise((resolve, reject) => {
      const client = this.connect();

      client.ExtractEntities(
        request,
        new grpc.Metadata(),
        { deadline: this.deadline() },
        (err, response) => {
          if (err) {
            this.circuitBreaker.recordFailure();
            if (
              attempt < this.maxRetries &&
              RETRYABLE_CODES.has((err as grpc.ServiceError).code ?? -1)
            ) {
              const delay = retryDelay(attempt + 1, this.retryBaseDelayMs);
              setTimeout(() => {
                this.executeWithRetry(request, attempt + 1).then(resolve, reject);
              }, delay);
              return;
            }
            reject(err);
            return;
          }

          if (!response) {
            this.circuitBreaker.recordFailure();
            reject(new Error('Empty gRPC response'));
            return;
          }

          this.circuitBreaker.recordSuccess();
          resolve({
            entities: (response.entities || []).map((e) => ({
              text: e.text,
              type: e.type,
              confidence: e.confidence,
              context: e.context,
              status: e.status,
            })),
            metadata: {
              glinerCount: response.metadata?.gliner_count ?? 0,
              flairCount: response.metadata?.flair_count ?? 0,
              conflicts: response.metadata?.conflicts ?? 0,
              llmReviewed: response.metadata?.llm_reviewed ?? 0,
              finalCount: response.metadata?.final_count ?? 0,
              stage1LatencyMs: response.metadata?.stage1_latency_ms ?? 0,
              stage3LatencyMs: response.metadata?.stage3_latency_ms ?? 0,
              llmInvoked: response.metadata?.llm_invoked ?? false,
              glinerAvailable: response.metadata?.gliner_available ?? false,
              flairAvailable: response.metadata?.flair_available ?? false,
            },
          });
        },
      );
    });
  }

  shutdown(): void {
    if (this.client) {
      (this.client as unknown as grpc.Client).close();
      this.client = null;
    }
  }
}
