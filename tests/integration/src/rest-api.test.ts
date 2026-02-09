/**
 * REST API CRUD integration tests against Docker stack.
 *
 * Tests the auto-generated REST routes (MVP Section 8.2):
 *   GET  /api/v1/{plural}          — list with filters
 *   GET  /api/v1/{plural}/:id      — get by ID
 *   GET  /api/v1/{plural}/:id/links/:linkType — linked objects
 *   GET  /api/v1/{plural}/:id/history — version history
 *   POST /api/v1/actions/{Name}    — execute action
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { restGet, restPost, restRaw } from './client.js';
import { ensureStack } from './setup.js';
import type { SeededData } from './seed.js';
import type { RestListResponse, RestItemResponse, ActionResponse } from './client.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('REST API', () => {
  let data: SeededData;

  beforeAll(async () => {
    data = await ensureStack();
  });

  describe('List endpoints', () => {
    it('GET /api/v1/patients should return paginated patient list', async () => {
      const result = await restGet<RestListResponse>('/patients');

      expect(result.data).toBeDefined();
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.pagination).toBeDefined();
      expect(result.pagination.totalCount).toBeGreaterThanOrEqual(3);
    });

    it('GET /api/v1/wards should return ward list', async () => {
      const result = await restGet<RestListResponse>('/wards');

      expect(result.data).toBeDefined();
      expect(result.data.length).toBeGreaterThanOrEqual(2);
    });

    it('should support filter[field]=value query params', async () => {
      const result = await restGet<RestListResponse>('/wards', {
        'filter[specialty]': 'Cardiology',
      });

      expect(result.data).toBeDefined();
      for (const ward of result.data) {
        expect((ward as Record<string, unknown>).specialty).toBe('Cardiology');
      }
    });

    it('should support limit and offset pagination', async () => {
      const page1 = await restGet<RestListResponse>('/patients', {
        limit: '1',
        offset: '0',
      });

      expect(page1.data.length).toBe(1);
      expect(page1.pagination.limit).toBe(1);
      expect(page1.pagination.offset).toBe(0);
      expect(page1.pagination.hasNextPage).toBe(true);

      const page2 = await restGet<RestListResponse>('/patients', {
        limit: '1',
        offset: '1',
      });

      expect(page2.data.length).toBe(1);
      expect(page2.pagination.offset).toBe(1);
      expect(page2.pagination.hasPreviousPage).toBe(true);
    });
  });

  describe('Get by ID endpoints', () => {
    it('GET /api/v1/patients/:id should return a single patient', async () => {
      const result = await restGet<RestItemResponse>(`/patients/${data.patients.doe.id}`);

      expect(result.data).toBeDefined();
      expect((result.data as Record<string, unknown>).id).toBe(data.patients.doe.id);
      expect((result.data as Record<string, unknown>).nhsNumber).toBe('9434765919');
    });

    it('GET /api/v1/wards/:id should return a single ward', async () => {
      const result = await restGet<RestItemResponse>(`/wards/${data.wards.general.id}`);

      expect(result.data).toBeDefined();
      expect((result.data as Record<string, unknown>).name).toBe('Ward A - General');
    });

    it('should return 404 for non-existent object', async () => {
      const response = await restRaw('/patients/nonexistent-id-12345');

      expect(response.status).toBe(404);
    });
  });

  describe('Links endpoints', () => {
    it('GET /api/v1/patients/:id/links/AdmittedTo should return admission links', async () => {
      // First admit a patient to create links
      await restPost<ActionResponse>('/actions/AdmitPatient', {
        patient: data.patients.roe.id,
        ward: data.wards.general.id,
        bed: data.beds.a1.id,
        consultant: data.consultants.smith.id,
        reason: 'REST API test',
      });

      const result = await restGet<RestListResponse>(
        `/patients/${data.patients.roe.id}/links/AdmittedTo`,
      );

      expect(result.data).toBeDefined();
      expect(result.data.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('History endpoints', () => {
    it('GET /api/v1/patients/:id/history should return version history', async () => {
      const result = await restGet<{ data: Array<Record<string, unknown>> }>(
        `/patients/${data.patients.roe.id}/history`,
      );

      expect(result.data).toBeDefined();
      expect(Array.isArray(result.data)).toBe(true);
      // Should have at least 1 version (the original creation)
      expect(result.data.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Action execution via REST', () => {
    it('POST /api/v1/actions/AdmitPatient should execute action', async () => {
      const result = await restPost<ActionResponse>('/actions/AdmitPatient', {
        patient: data.patients.moe.id,
        ward: data.wards.cardiology.id,
        bed: data.beds.b2.id,
        consultant: data.consultants.jones.id,
        reason: 'REST action test',
      });

      expect(result.data).toBeDefined();
      expect(result.data.success).toBe(true);
      expect(result.data.actionId).toBeDefined();
      expect(result.data.affectedObjects.length).toBeGreaterThan(0);
    });
  });
});
