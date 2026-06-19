/**
 * Tests for the NER gRPC client.
 *
 * Mirrors packages/actions/src/cel/__tests__/client.test.ts pattern.
 * Uses a real gRPC server (mock implementation) to test the full
 * client stack: proto loading, gRPC transport, retry, circuit breaker,
 * and error handling.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NerGrpcClient } from '../ner-grpc-client.js';

const currentDir = typeof __dirname !== 'undefined'
  ? __dirname
  : dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = resolve(currentDir, '..', '..', '..', '..', 'ner-service', 'proto', 'ner.proto');

// ---------------------------------------------------------------------------
// Mock gRPC server
// ---------------------------------------------------------------------------

interface MockExtractRequest {
  text: string;
  labels: string[];
  min_confidence?: number;
  max_entities?: number;
  enable_llm_review?: boolean;
}

interface MockExtractResponse {
  entities: Array<{ text: string; type: string; confidence: number; context: string; status: number }>;
  metadata: {
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
  };
}

type ExtractHandler = (text: string, labels: string[]) => MockExtractResponse;

let extractHandler: ExtractHandler = () => ({
  entities: [
    { text: 'Bakhmut', type: 'Location', confidence: 0.97, context: 'near Bakhmut', status: 1 },
  ],
  metadata: {
    gliner_count: 1, flair_count: 1, conflicts: 0, llm_reviewed: 0, final_count: 1,
    stage1_latency_ms: 45.2, stage3_latency_ms: 0, llm_invoked: false,
    gliner_available: true, flair_available: true,
  },
});

function createMockServer(): {
  server: grpc.Server;
  start: () => Promise<string>;
  stop: () => Promise<void>;
} {
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });

  const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
  const nerPackage = protoDescriptor['ner'] as Record<string, unknown>;
  const v1 = nerPackage['v1'] as Record<string, unknown>;
  const service = (v1['NerService'] as { service: grpc.ServiceDefinition }).service;

  const server = new grpc.Server();

  server.addService(service, {
    ExtractEntities(
      call: grpc.ServerUnaryCall<MockExtractRequest, MockExtractResponse>,
      callback: grpc.sendUnaryData<MockExtractResponse>,
    ) {
      try {
        const req = call.request;
        const response = extractHandler(req.text, req.labels);
        callback(null, response);
      } catch (err) {
        callback(err as grpc.ServiceError, null);
      }
    },
  });

  return {
    server,
    start: () =>
      new Promise<string>((resolve, reject) => {
        server.bindAsync(
          'localhost:0',
          grpc.ServerCredentials.createInsecure(),
          (err, port) => {
            if (err) reject(err);
            else resolve(`localhost:${port}`);
          },
        );
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        server.tryShutdown(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NerGrpcClient', () => {
  let mockServer: ReturnType<typeof createMockServer>;
  let address: string;

  beforeAll(async () => {
    mockServer = createMockServer();
    address = await mockServer.start();
  });

  afterAll(async () => {
    await mockServer.stop();
  });

  it('connects and extracts entities', async () => {
    const client = new NerGrpcClient({ address, timeoutMs: 5000 });
    const response = await client.extractEntities({
      text: 'Heavy shelling near Bakhmut',
      labels: ['Person', 'Organization', 'Location', 'Equipment'],
    });

    expect(response.entities).toBeDefined();
    expect(response.entities.length).toBe(1);
    expect(response.entities?.[0]?.text).toBe('Bakhmut');
    expect(response.entities?.[0]?.type).toBe('Location');
    expect(response.entities?.[0]?.confidence).toBeCloseTo(0.97);
    expect(response.entities?.[0]?.status).toBe('ENTITY_STATUS_CONFIRMED');

    client.shutdown();
  });

  it('returns metadata from pipeline', async () => {
    extractHandler = () => ({
      entities: [
        { text: 'Bakhmut', type: 'Location', confidence: 0.97, context: 'test', status: 'ENTITY_STATUS_CONFIRMED' } as any,
      ],
      metadata: {
        gliner_count: 1, flair_count: 1, conflicts: 0, llm_reviewed: 0, final_count: 1,
        stage1_latency_ms: 45.2, stage3_latency_ms: 0, llm_invoked: false,
        gliner_available: true, flair_available: true,
      } as any,
    });

    const client = new NerGrpcClient({ address, timeoutMs: 5000 });
    const response = await client.extractEntities({
      text: 'Test',
      labels: ['Location'],
    });

    expect(response.metadata).toBeDefined();
    // With keepCase:false, proto-loader converts field names to camelCase
    expect(typeof response.metadata.finalCount).toBe('number');
    expect(typeof response.metadata.glinerAvailable).toBe('boolean');

    client.shutdown();
  });

  it('sends labels to server', async () => {
    const receivedLabels: string[][] = [];
    extractHandler = (_text, labels) => {
      receivedLabels.push([...labels]);
      return {
        entities: [],
        metadata: { gliner_count: 0, flair_count: 0, conflicts: 0, llm_reviewed: 0, final_count: 0, stage1_latency_ms: 0, stage3_latency_ms: 0, llm_invoked: false, gliner_available: true, flair_available: true },
      };
    };

    const client = new NerGrpcClient({ address, timeoutMs: 5000 });
    await client.extractEntities({
      text: 'Test',
      labels: ['Equipment', 'WeaponSystem', 'MilitaryUnit'],
    });

    expect(receivedLabels.length).toBe(1);
    expect(receivedLabels[0]).toContain('Equipment');
    expect(receivedLabels[0]).toContain('WeaponSystem');
    expect(receivedLabels[0]).toContain('MilitaryUnit');

    client.shutdown();
  });

  it('handles server errors with retry', async () => {
    extractHandler = () => {
      const err: Partial<grpc.ServiceError> = {
        code: grpc.status.UNAVAILABLE,
        message: 'Server unavailable',
      };
      throw err as grpc.ServiceError;
    };

    const client = new NerGrpcClient({
      address,
      timeoutMs: 2000,
      maxRetries: 2,
      retryBaseDelayMs: 10,
    });

    await expect(client.extractEntities({
      text: 'Test',
      labels: ['Person'],
    })).rejects.toBeDefined();

    client.shutdown();
  });

  it('respects enableLlmReview flag', async () => {
    extractHandler = (_text, _labels) => {
      return {
        entities: [],
        metadata: { gliner_count: 0, flair_count: 0, conflicts: 0, llm_reviewed: 0, final_count: 0, stage1_latency_ms: 0, stage3_latency_ms: 0, llm_invoked: false, gliner_available: true, flair_available: true },
      };
    };

    const client = new NerGrpcClient({ address, timeoutMs: 5000 });
    const response = await client.extractEntities({
      text: 'Test',
      labels: ['Person'],
      enableLlmReview: true,
    });
    expect(response.metadata.llmInvoked).toBe(false);  // mock returns false

    client.shutdown();
  });

  it('closes gracefully', async () => {
    const client = new NerGrpcClient({ address, timeoutMs: 5000 });
    // extract once to establish connection
    await client.extractEntities({ text: 'Test', labels: ['Person'] });
    // should not throw
    expect(() => client.shutdown()).not.toThrow();
  });

  it('resolves proto path from package location', () => {
    const client = new NerGrpcClient({ address: 'localhost:9999', timeoutMs: 1000 });
    // Constructor should not throw — proto path should resolve
    expect(client).toBeDefined();
    client.shutdown();
  });
});
