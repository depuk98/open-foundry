/**
 * In-memory consent store for testing.
 *
 * Stores consent records and opt-out status in memory.
 * Production deployments use a persistent store backed by PostgreSQL.
 */

import type { ConsentRecord } from "@openfoundry/spi";

import type { ConsentStore } from "./types.js";

export class MemoryConsentStore implements ConsentStore {
  private readonly records: ConsentRecord[] = [];
  private readonly optOuts = new Set<string>();
  // PERF-06: Maximum records to prevent unbounded memory growth
  private static readonly MAX_RECORDS = 100_000;

  async put(record: ConsentRecord): Promise<void> {
    this.records.push(structuredClone(record));
    if (this.records.length > MemoryConsentStore.MAX_RECORDS) {
      this.records.splice(0, this.records.length - MemoryConsentStore.MAX_RECORDS);
    }
  }

  async getBySubject(subjectId: string): Promise<ConsentRecord[]> {
    return this.records.filter(r => r.subjectId === subjectId);
  }

  async hasOptOut(subjectId: string): Promise<boolean> {
    return this.optOuts.has(subjectId);
  }

  async setOptOut(subjectId: string, optedOut: boolean): Promise<void> {
    if (optedOut) {
      this.optOuts.add(subjectId);
    } else {
      this.optOuts.delete(subjectId);
    }
  }

  /** Test helper: return all stored records. */
  all(): readonly ConsentRecord[] {
    return this.records;
  }

  /** Test helper: return count of stored records. */
  get size(): number {
    return this.records.length;
  }
}
