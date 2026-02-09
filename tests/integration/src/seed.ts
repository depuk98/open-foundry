/**
 * Seed synthetic data into the running Docker stack via the API.
 *
 * Creates a minimal dataset for integration tests:
 * - 2 Wards (General + Cardiology)
 * - 4 Beds (2 per ward)
 * - 2 Consultants
 * - 3 Patients (1 discharged, 2 unassigned)
 *
 * Uses the GraphQL mutation API to create objects, matching what
 * a real client would do.
 */

import { graphql } from './client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SeededData {
  wards: { general: SeededObject; cardiology: SeededObject };
  beds: { a1: SeededObject; a2: SeededObject; b1: SeededObject; b2: SeededObject };
  consultants: { smith: SeededObject; jones: SeededObject };
  patients: { doe: SeededObject; roe: SeededObject; moe: SeededObject };
}

export interface SeededObject {
  id: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// GraphQL mutations for seeding
// ---------------------------------------------------------------------------

const CREATE_WARD = `
  mutation CreateWard($input: WardInput!) {
    createWard(input: $input) { id name specialty capacity }
  }
`;

const CREATE_BED = `
  mutation CreateBed($input: BedInput!) {
    createBed(input: $input) { id number status }
  }
`;

const CREATE_CONSULTANT = `
  mutation CreateConsultant($input: ConsultantInput!) {
    createConsultant(input: $input) { id name gmcNumber specialty }
  }
`;

const CREATE_PATIENT = `
  mutation CreatePatient($input: PatientInput!) {
    createPatient(input: $input) { id nhsNumber name dateOfBirth status }
  }
`;

// ---------------------------------------------------------------------------
// Seed function
// ---------------------------------------------------------------------------

async function createObject<T extends { id: string }>(
  mutation: string,
  input: Record<string, unknown>,
  typeName: string,
): Promise<T> {
  const mutationName = `create${typeName}`;
  const result = await graphql<Record<string, T>>(mutation, { input });
  if (result.errors) {
    throw new Error(
      `Failed to create ${typeName}: ${result.errors.map((e) => e.message).join(', ')}`,
    );
  }
  const obj = result.data?.[mutationName];
  if (!obj) {
    throw new Error(`No data returned for create${typeName}`);
  }
  return obj;
}

/**
 * Seed the Docker stack with test data via GraphQL API.
 * Returns references to all created objects.
 */
export async function seedTestData(): Promise<SeededData> {
  // Wards
  const general = await createObject<SeededObject>(CREATE_WARD, {
    name: 'Ward A - General',
    specialty: 'General',
    capacity: 20,
  }, 'Ward');

  const cardiology = await createObject<SeededObject>(CREATE_WARD, {
    name: 'Ward B - Cardiology',
    specialty: 'Cardiology',
    capacity: 15,
  }, 'Ward');

  // Beds
  const a1 = await createObject<SeededObject>(CREATE_BED, {
    number: 'A-1',
    status: 'AVAILABLE',
  }, 'Bed');

  const a2 = await createObject<SeededObject>(CREATE_BED, {
    number: 'A-2',
    status: 'AVAILABLE',
  }, 'Bed');

  const b1 = await createObject<SeededObject>(CREATE_BED, {
    number: 'B-1',
    status: 'AVAILABLE',
  }, 'Bed');

  const b2 = await createObject<SeededObject>(CREATE_BED, {
    number: 'B-2',
    status: 'AVAILABLE',
  }, 'Bed');

  // Consultants
  const smith = await createObject<SeededObject>(CREATE_CONSULTANT, {
    name: 'Dr Smith',
    gmcNumber: 'GMC100001',
    specialty: 'General',
  }, 'Consultant');

  const jones = await createObject<SeededObject>(CREATE_CONSULTANT, {
    name: 'Dr Jones',
    gmcNumber: 'GMC100002',
    specialty: 'Cardiology',
  }, 'Consultant');

  // Patients
  const doe = await createObject<SeededObject>(CREATE_PATIENT, {
    nhsNumber: '9434765919',
    name: 'Jane Doe',
    dateOfBirth: '1990-05-15',
    status: 'DISCHARGED',
  }, 'Patient');

  const roe = await createObject<SeededObject>(CREATE_PATIENT, {
    nhsNumber: '9434765927',
    name: 'John Roe',
    dateOfBirth: '1985-03-20',
    status: 'DISCHARGED',
  }, 'Patient');

  const moe = await createObject<SeededObject>(CREATE_PATIENT, {
    nhsNumber: '9434765935',
    name: 'Mary Moe',
    dateOfBirth: '1975-11-01',
    status: 'DISCHARGED',
  }, 'Patient');

  return {
    wards: { general, cardiology },
    beds: { a1, a2, b1, b2 },
    consultants: { smith, jones },
    patients: { doe, roe, moe },
  };
}
