/**
 * End-to-end patient lifecycle tests against Docker stack.
 *
 * Tests the full Admit -> Transfer -> Discharge journey via the GraphQL API,
 * matching MVP Section 7.1 but running against the real service stack.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { graphql, restGet } from './client.js';
import { ensureStack, dockerAvailable } from './setup.js';
import type { SeededData } from './seed.js';
import type { RestListResponse } from './client.js';

// ---------------------------------------------------------------------------
// Queries and Mutations
// ---------------------------------------------------------------------------

const ADMIT_PATIENT = `
  mutation AdmitPatient($input: AdmitPatientInput!) {
    admitPatient(input: $input) {
      success
      actionId
      errors { code message }
      affectedObjects { typeName id changeType }
    }
  }
`;

const TRANSFER_WARD = `
  mutation TransferWard($input: TransferWardInput!) {
    transferWard(input: $input) {
      success
      actionId
      errors { code message }
      affectedObjects { typeName id changeType }
    }
  }
`;

const DISCHARGE_PATIENT = `
  mutation DischargePatient($input: DischargePatientInput!) {
    dischargePatient(input: $input) {
      success
      actionId
      errors { code message }
      affectedObjects { typeName id changeType }
    }
  }
`;

const GET_PATIENT = `
  query GetPatient($id: ID!) {
    patient(id: $id) {
      id
      nhsNumber
      name
      dateOfBirth
      status
      currentWard { id }
    }
  }
`;


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!dockerAvailable)('Patient Lifecycle E2E', () => {
  let data: SeededData;

  beforeAll(async () => {
    data = await ensureStack();
  });

  describe('Admit -> Transfer -> Discharge', () => {
    it('should admit a patient to a ward via GraphQL action', async () => {
      const result = await graphql<{ admitPatient: { success: boolean; errors: string[] | null } }>(
        ADMIT_PATIENT,
        {
          input: {
            patient: data.patients.doe.id,
            ward: data.wards.general.id,
            bed: data.beds.a1.id,
            consultant: data.consultants.smith.id,
            reason: 'Chest pain',
          },
        },
      );

      expect(result.errors).toBeUndefined();
      expect(result.data?.admitPatient.success).toBe(true);
      expect(result.data?.admitPatient.errors).toBeNull();

      // Verify patient status changed to ACTIVE
      const patient = await graphql<{ patient: { status: string } }>(
        GET_PATIENT,
        { id: data.patients.doe.id },
      );
      expect(patient.data?.patient.status).toBe('ACTIVE');
    });

    it('should have created admission links after admit', async () => {
      // Status reads correctly via GraphQL.
      const result = await graphql<{ patient: { status: string } }>(
        GET_PATIENT,
        { id: data.patients.doe.id },
      );
      expect(result.errors).toBeUndefined();
      expect(result.data?.patient.status).toBe('ACTIVE');

      // Verify the admit created the relationship links via the REST traversal
      // endpoint. NOTE: GraphQL nested link fields (patient.currentWard, etc.)
      // are NOT resolved by the generated resolvers — relationship traversal is
      // only wired into the REST/FHIR/CDM layers, not GraphQL. Tracked as a
      // known gap.
      for (const linkType of ['AdmittedTo', 'OccupiesBed', 'UnderCareOf']) {
        const links = await restGet<RestListResponse>(
          `/patients/${data.patients.doe.id}/links/${linkType}`,
        );
        expect(links.data.length, `${linkType} link`).toBeGreaterThanOrEqual(1);
      }
    });

    it('should transfer a patient to another ward via GraphQL action', async () => {
      const result = await graphql<{ transferWard: { success: boolean; errors: string[] | null } }>(
        TRANSFER_WARD,
        {
          input: {
            patient: data.patients.doe.id,
            toWard: data.wards.cardiology.id,
            toBed: data.beds.b1.id,
            reason: 'Cardiology consult needed',
          },
        },
      );

      expect(result.errors).toBeUndefined();
      expect(result.data?.transferWard.success).toBe(true);

      // Patient should still be ACTIVE after transfer
      const patient = await graphql<{ patient: { status: string } }>(
        GET_PATIENT,
        { id: data.patients.doe.id },
      );
      expect(patient.data?.patient.status).toBe('ACTIVE');
    });

    it('should discharge a patient via GraphQL action', async () => {
      const result = await graphql<{ dischargePatient: { success: boolean; errors: string[] | null } }>(
        DISCHARGE_PATIENT,
        {
          input: {
            patient: data.patients.doe.id,
            destination: 'HOME',
            notes: 'Recovered well',
          },
        },
      );

      expect(result.errors).toBeUndefined();
      expect(result.data?.dischargePatient.success).toBe(true);

      // Patient should be DISCHARGED
      const patient = await graphql<{ patient: { status: string } }>(
        GET_PATIENT,
        { id: data.patients.doe.id },
      );
      expect(patient.data?.patient.status).toBe('DISCHARGED');
    });
  });

  describe('Concurrent admissions', () => {
    it('should admit multiple patients independently', async () => {
      // Admit patient Roe to General Ward
      const result1 = await graphql<{ admitPatient: { success: boolean } }>(
        ADMIT_PATIENT,
        {
          input: {
            patient: data.patients.roe.id,
            ward: data.wards.general.id,
            bed: data.beds.a2.id,
            consultant: data.consultants.smith.id,
          },
        },
      );

      // Admit patient Moe to Cardiology Ward
      const result2 = await graphql<{ admitPatient: { success: boolean } }>(
        ADMIT_PATIENT,
        {
          input: {
            patient: data.patients.moe.id,
            ward: data.wards.cardiology.id,
            bed: data.beds.b2.id,
            consultant: data.consultants.jones.id,
          },
        },
      );

      expect(result1.data?.admitPatient.success).toBe(true);
      expect(result2.data?.admitPatient.success).toBe(true);
    });
  });
});
