/**
 * Tests for the GraphQL API layer.
 *
 * Tests auto-generated resolvers with mocked Engine, Security, and Action
 * dependencies. Uses the NHS Acute ODL schema to validate:
 * - Query patient by ID
 * - Query patients with filter (list query)
 * - Mutation dischargePatient
 * - Field-level redaction
 * - Relay pagination
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseOdl } from '@openfoundry/odl';
import type { ParsedSchema } from '@openfoundry/odl';
import type { OntologyObject, ObjectPage } from '@openfoundry/spi';
import type { ActionResult } from '@openfoundry/actions';
import { generateResolvers } from '../graphql/resolver-generator.js';
import { buildConnection, encodeCursor, decodeCursor, resolvePagination } from '../graphql/pagination.js';
import { createOpenFoundryError, wrapError } from '../graphql/errors.js';
import type { ApiDependencies, ResolverContext, AuthenticatedUserInfo } from '../graphql/types.js';

// ─── NHS Acute ODL fixture ───

const NHS_ACUTE_ODL = `
extend schema @namespace(name: "nhs.acute", version: "0.1.0")

type Patient @objectType {
  id: ID! @primary
  nhsNumber: String @unique @indexed
  name: String! @sensitive @searchable(weight: 2.0)
  dateOfBirth: Date! @sensitive
  status: PatientStatus!
  triageCategory: TriageCategory
}

enum PatientStatus {
  ACTIVE
  DISCHARGED
  DECEASED
  TRANSFERRED
}

enum TriageCategory {
  P1_IMMEDIATE
  P2_URGENT
  P3_DELAYED
  P4_EXPECTANT
}

type Ward @objectType {
  id: ID! @primary
  name: String! @indexed
  specialty: String!
  capacity: Int! @constraint(expr: "value > 0")
}

type Bed @objectType {
  id: ID! @primary
  number: String! @indexed
  type: BedType!
  status: BedStatus!
}

enum BedType {
  STANDARD
  ICU
  HDU
  ISOLATION
  TROLLEY
}

enum BedStatus {
  AVAILABLE
  OCCUPIED
  CLEANING
  OUT_OF_SERVICE
}

type Consultant @objectType {
  id: ID! @primary
  gmcNumber: String @unique @indexed
  name: String!
  specialty: String!
}

type DischargePatient @actionType {
  patient: Patient! @param
  destination: DischargeDestination! @param
  notes: String @param
}

type AdmitPatient @actionType {
  patient: Patient! @param
  ward: Ward! @param
  reason: String @param
}

enum DischargeDestination {
  HOME
  CARE_HOME
  VIRTUAL_WARD
  TRANSFER
  DECEASED
}
`;

// ─── Mock factories ───

function createMockUser(): AuthenticatedUserInfo {
  return {
    id: 'user-1',
    name: 'Dr Smith',
    email: 'dr.smith@nhs.uk',
    roles: ['clinician'],
    groups: [],
    tenantId: 'tenant-1',
  };
}

function createPatientObject(id: string, overrides: Record<string, unknown> = {}): OntologyObject {
  return {
    _tenantId: 'tenant-1',
    _type: 'Patient',
    _id: id,
    _version: 1,
    _createdAt: '2025-01-01T00:00:00Z',
    _updatedAt: '2025-01-01T00:00:00Z',
    nhsNumber: `NHS-${id}`,
    name: `Patient ${id}`,
    dateOfBirth: '1990-01-01',
    status: 'ACTIVE',
    triageCategory: null,
    ...overrides,
  };
}

function createMockDeps(schema: ParsedSchema): ApiDependencies {
  return {
    schema,
    objectManager: {
      get: vi.fn(),
      query: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    } as unknown as ApiDependencies['objectManager'],
    linkManager: {} as unknown as ApiDependencies['linkManager'],
    actionExecutor: {
      execute: vi.fn(),
    } as unknown as ApiDependencies['actionExecutor'],
    authorizationService: {
      check: vi.fn().mockResolvedValue(true),
      listObjects: vi.fn().mockResolvedValue([]),
      redactFields: vi.fn().mockImplementation(
        (_userId: string, _roles: string[], _type: string, obj: Record<string, unknown>) => ({
          data: obj,
          _redactedFields: [],
        }),
      ),
      redactFieldsBatch: vi.fn().mockImplementation(
        (_userId: string, _roles: string[], _type: string, objects: Record<string, unknown>[]) =>
          objects.map(obj => ({ data: obj, _redactedFields: [] })),
      ),
      clearFieldCache: vi.fn(),
    } as unknown as ApiDependencies['authorizationService'],
    authenticator: {} as unknown as ApiDependencies['authenticator'],
    manifestRegistry: {
      get: (name: string) => ({
        action: name,
        version: 1,
        reversible: false,
        preconditions: [],
        effects: [],
        sideEffects: [],
      }),
    },
    consentService: undefined,
    auditWriter: undefined,
    storage: {} as unknown as ApiDependencies['storage'],
  };
}

function createResolverContext(
  deps: ApiDependencies,
  user?: AuthenticatedUserInfo,
): ResolverContext {
  const u = user ?? createMockUser();
  return {
    requestContext: {
      tenantId: u.tenantId,
      actorId: u.id,
      traceId: 'trace-test',
    },
    user: u,
    deps,
  };
}

// Helper to get resolver functions safely
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function Q(resolvers: Record<string, Record<string, any>>, name: string): (...args: any[]) => any {
  return resolvers['Query']![name] as (...args: unknown[]) => unknown;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function M(resolvers: Record<string, Record<string, any>>, name: string): (...args: any[]) => any {
  return resolvers['Mutation']![name] as (...args: unknown[]) => unknown;
}

// ─── Tests ───

describe('GraphQL API', () => {
  let parsed: ParsedSchema;

  beforeEach(() => {
    parsed = parseOdl(NHS_ACUTE_ODL);
  });

  describe('schema generation', () => {
    it('produces a valid GraphQL schema with resolvers', () => {
      const deps = createMockDeps(parsed);
      const { resolvers } = generateResolvers(parsed, deps);

      expect(resolvers['Query']).toBeDefined();
      expect(resolvers['Mutation']).toBeDefined();
      expect(resolvers['Subscription']).toBeDefined();
    });

    it('generates query resolvers for each ObjectType', () => {
      const deps = createMockDeps(parsed);
      const { resolvers } = generateResolvers(parsed, deps);
      const query = resolvers['Query']!;

      expect(query['patient']).toBeTypeOf('function');
      expect(query['ward']).toBeTypeOf('function');
      expect(query['bed']).toBeTypeOf('function');
      expect(query['consultant']).toBeTypeOf('function');

      expect(query['patients']).toBeTypeOf('function');
      expect(query['wards']).toBeTypeOf('function');
      expect(query['beds']).toBeTypeOf('function');
      expect(query['consultants']).toBeTypeOf('function');
    });

    it('generates mutation resolvers for each ActionType', () => {
      const deps = createMockDeps(parsed);
      const { resolvers } = generateResolvers(parsed, deps);
      const mutation = resolvers['Mutation']!;

      expect(mutation['dischargePatient']).toBeTypeOf('function');
      expect(mutation['admitPatient']).toBeTypeOf('function');
    });

    it('generates availableTools query', () => {
      const deps = createMockDeps(parsed);
      const { resolvers } = generateResolvers(parsed, deps);

      expect(resolvers['Query']!['availableTools']).toBeTypeOf('function');
    });

    it('generates subscription resolvers for each ObjectType', () => {
      const deps = createMockDeps(parsed);
      const { resolvers } = generateResolvers(parsed, deps);
      const sub = resolvers['Subscription']!;

      expect(sub['patientChanged']).toBeDefined();
      expect(sub['wardChanged']).toBeDefined();
      expect(sub['bedChanged']).toBeDefined();
      expect(sub['consultantChanged']).toBeDefined();
    });
  });

  describe('query patient by ID', () => {
    it('returns correct fields for a patient', async () => {
      const deps = createMockDeps(parsed);
      const patient = createPatientObject('p-1');
      const getMock = deps.objectManager.get as ReturnType<typeof vi.fn>;
      getMock.mockResolvedValue(patient);

      const { resolvers } = generateResolvers(parsed, deps);
      const ctx = createResolverContext(deps);

      const result = await Q(resolvers, 'patient')(null, { id: 'p-1' }, ctx);

      expect(result).toBeDefined();
      expect(result.id).toBe('p-1');
      expect(result.nhsNumber).toBe('NHS-p-1');
      expect(result.name).toBe('Patient p-1');
      expect(result.dateOfBirth).toBe('1990-01-01');
      expect(result.status).toBe('ACTIVE');
    });

    it('returns null for non-existent patient', async () => {
      const deps = createMockDeps(parsed);
      const getMock = deps.objectManager.get as ReturnType<typeof vi.fn>;
      getMock.mockResolvedValue(null);

      const { resolvers } = generateResolvers(parsed, deps);
      const ctx = createResolverContext(deps);

      const result = await Q(resolvers, 'patient')(null, { id: 'no-such' }, ctx);
      expect(result).toBeNull();
    });

    it('throws authorization error when user lacks access', async () => {
      const deps = createMockDeps(parsed);
      const checkMock = deps.authorizationService.check as ReturnType<typeof vi.fn>;
      checkMock.mockResolvedValue(false);

      const { resolvers } = generateResolvers(parsed, deps);
      const ctx = createResolverContext(deps);

      await expect(
        Q(resolvers, 'patient')(null, { id: 'p-1' }, ctx),
      ).rejects.toThrow(/Access denied/);
    });

    it('calls authorization check with correct user and resource', async () => {
      const deps = createMockDeps(parsed);
      const patient = createPatientObject('p-1');
      (deps.objectManager.get as ReturnType<typeof vi.fn>).mockResolvedValue(patient);

      const { resolvers } = generateResolvers(parsed, deps);
      const ctx = createResolverContext(deps);

      await Q(resolvers, 'patient')(null, { id: 'p-1' }, ctx);

      expect(deps.authorizationService.check).toHaveBeenCalledWith(
        'user:user-1',
        'viewer',
        'patient:p-1',
      );
    });
  });

  describe('query patients with filter', () => {
    it('returns filtered list via connection', async () => {
      const deps = createMockDeps(parsed);
      const listMock = deps.authorizationService.listObjects as ReturnType<typeof vi.fn>;
      listMock.mockResolvedValue(['patient:p-1', 'patient:p-2', 'patient:p-3']);

      const queryMock = deps.objectManager.query as ReturnType<typeof vi.fn>;
      const page: ObjectPage = {
        items: [createPatientObject('p-1'), createPatientObject('p-2')],
        totalCount: 3,
        hasNextPage: true,
      };
      queryMock.mockResolvedValue(page);

      const { resolvers } = generateResolvers(parsed, deps);
      const ctx = createResolverContext(deps);

      const result = await Q(resolvers, 'patients')(
        null,
        { filter: { status: { eq: 'ACTIVE' } }, first: 2 },
        ctx,
      );

      expect(result.edges).toHaveLength(2);
      expect(result.edges[0].node.id).toBe('p-1');
      expect(result.edges[1].node.id).toBe('p-2');
      expect(result.totalCount).toBe(3);
      expect(result.pageInfo.hasNextPage).toBe(true);
    });

    it('passes authorization filter to query', async () => {
      const deps = createMockDeps(parsed);
      const listMock = deps.authorizationService.listObjects as ReturnType<typeof vi.fn>;
      listMock.mockResolvedValue(['patient:p-1', 'patient:p-5']);

      const queryMock = deps.objectManager.query as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValue({ items: [], totalCount: 0, hasNextPage: false });

      const { resolvers } = generateResolvers(parsed, deps);
      const ctx = createResolverContext(deps);

      await Q(resolvers, 'patients')(null, {}, ctx);

      const queryArgs = queryMock.mock.calls[0]!;
      expect(queryArgs[0]).toBe('Patient');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const filter = queryArgs[1] as any;
      expect(filter.field).toBe('_id');
      expect(filter.operator).toBe('in');
      expect(filter.value).toEqual(['p-1', 'p-5']);
    });
  });

  describe('mutation dischargePatient', () => {
    it('executes action and returns result', async () => {
      const deps = createMockDeps(parsed);
      const executeMock = deps.actionExecutor.execute as ReturnType<typeof vi.fn>;
      const actionResult: ActionResult = {
        success: true,
        actionId: 'act_123',
        errors: [],
        affectedObjects: [
          { type: 'Patient', id: 'p-1', changeType: 'updated' },
        ],
      };
      executeMock.mockResolvedValue(actionResult);

      const { resolvers } = generateResolvers(parsed, deps);
      const ctx = createResolverContext(deps);

      const result = await M(resolvers, 'dischargePatient')(
        null,
        { input: { patient: 'p-1', destination: 'HOME', notes: 'Recovered' } },
        ctx,
      );

      expect(result.success).toBe(true);
      expect(result.actionId).toBe('act_123');
      expect(result.affectedObjects).toHaveLength(1);
      expect(result.affectedObjects[0].typeName).toBe('Patient');
      expect(result.affectedObjects[0].id).toBe('p-1');
      expect(result.affectedObjects[0].changeType).toBe('UPDATED');
    });

    it('passes correct params to ActionExecutor', async () => {
      const deps = createMockDeps(parsed);
      const executeMock = deps.actionExecutor.execute as ReturnType<typeof vi.fn>;
      executeMock.mockResolvedValue({
        success: true,
        actionId: 'act_456',
        errors: [],
        affectedObjects: [],
      });

      const { resolvers } = generateResolvers(parsed, deps);
      const ctx = createResolverContext(deps);

      await M(resolvers, 'dischargePatient')(
        null,
        { input: { patient: 'p-1', destination: 'HOME' } },
        ctx,
      );

      expect(executeMock).toHaveBeenCalledTimes(1);
      const callArgs = executeMock.mock.calls[0]!;
      const manifest = callArgs[0];
      const params = callArgs[1];
      const actor = callArgs[2];
      expect(manifest.action).toBe('DischargePatient');
      expect(params).toEqual({ patient: 'p-1', destination: 'HOME' });
      expect(actor.id).toBe('user-1');
      expect(actor.type).toBe('user');
      expect(actor.roles).toEqual(['clinician']);
    });
  });

  describe('field-level redaction', () => {
    it('redacts unauthorized fields and populates _redactedFields', async () => {
      const deps = createMockDeps(parsed);
      const patient = createPatientObject('p-1');
      (deps.objectManager.get as ReturnType<typeof vi.fn>).mockResolvedValue(patient);

      const redactMock = deps.authorizationService.redactFields as ReturnType<typeof vi.fn>;
      redactMock.mockImplementation(
        (_userId: string, _roles: string[], _type: string, obj: Record<string, unknown>) => ({
          data: {
            ...obj,
            dateOfBirth: null,
            nhsNumber: null,
          },
          _redactedFields: ['dateOfBirth', 'nhsNumber'],
        }),
      );

      const { resolvers } = generateResolvers(parsed, deps);
      const ctx = createResolverContext(deps);

      const result = await Q(resolvers, 'patient')(null, { id: 'p-1' }, ctx);

      expect(result.dateOfBirth).toBeNull();
      expect(result.nhsNumber).toBeNull();
      expect(result._redactedFields).toEqual(['dateOfBirth', 'nhsNumber']);
    });

    it('returns null _redactedFields when no fields are redacted', async () => {
      const deps = createMockDeps(parsed);
      const patient = createPatientObject('p-1');
      (deps.objectManager.get as ReturnType<typeof vi.fn>).mockResolvedValue(patient);

      const { resolvers } = generateResolvers(parsed, deps);
      const ctx = createResolverContext(deps);

      const result = await Q(resolvers, 'patient')(null, { id: 'p-1' }, ctx);

      expect(result._redactedFields).toBeNull();
    });

    it('redacts fields in batch for list queries', async () => {
      const deps = createMockDeps(parsed);
      const listMock = deps.authorizationService.listObjects as ReturnType<typeof vi.fn>;
      listMock.mockResolvedValue(['patient:p-1', 'patient:p-2']);

      const queryMock = deps.objectManager.query as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValue({
        items: [createPatientObject('p-1'), createPatientObject('p-2')],
        totalCount: 2,
        hasNextPage: false,
      });

      const batchRedactMock = deps.authorizationService.redactFieldsBatch as ReturnType<typeof vi.fn>;
      batchRedactMock.mockImplementation(
        (_userId: string, _roles: string[], _type: string, objects: Record<string, unknown>[]) =>
          objects.map(obj => ({
            data: { ...obj, dateOfBirth: null },
            _redactedFields: ['dateOfBirth'],
          })),
      );

      const { resolvers } = generateResolvers(parsed, deps);
      const ctx = createResolverContext(deps);

      const result = await Q(resolvers, 'patients')(null, { first: 10 }, ctx);

      expect(result.edges[0].node.dateOfBirth).toBeNull();
      expect(result.edges[0].node._redactedFields).toEqual(['dateOfBirth']);
      expect(result.edges[1].node.dateOfBirth).toBeNull();
    });
  });

  describe('Relay pagination', () => {
    it('returns correct connection structure', async () => {
      const deps = createMockDeps(parsed);
      const listMock = deps.authorizationService.listObjects as ReturnType<typeof vi.fn>;
      listMock.mockResolvedValue(['patient:p-1', 'patient:p-2', 'patient:p-3']);

      const queryMock = deps.objectManager.query as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValue({
        items: [createPatientObject('p-1'), createPatientObject('p-2')],
        totalCount: 3,
        hasNextPage: true,
      });

      const { resolvers } = generateResolvers(parsed, deps);
      const ctx = createResolverContext(deps);

      const result = await Q(resolvers, 'patients')(null, { first: 2 }, ctx);

      expect(result.edges).toBeInstanceOf(Array);
      expect(result.pageInfo).toBeDefined();
      expect(result.totalCount).toBe(3);

      expect(result.edges[0].node).toBeDefined();
      expect(result.edges[0].cursor).toBeTypeOf('string');

      expect(result.pageInfo.hasNextPage).toBe(true);
      expect(result.pageInfo.hasPreviousPage).toBe(false);
      expect(result.pageInfo.startCursor).toBeTypeOf('string');
      expect(result.pageInfo.endCursor).toBeTypeOf('string');
    });

    it('first/after returns correct page', async () => {
      const deps = createMockDeps(parsed);
      const listMock = deps.authorizationService.listObjects as ReturnType<typeof vi.fn>;
      listMock.mockResolvedValue(['patient:p-1', 'patient:p-2', 'patient:p-3', 'patient:p-4']);

      const queryMock = deps.objectManager.query as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValue({
        items: [createPatientObject('p-3'), createPatientObject('p-4')],
        totalCount: 4,
        hasNextPage: false,
      });

      const { resolvers } = generateResolvers(parsed, deps);
      const ctx = createResolverContext(deps);

      const afterCursor = encodeCursor(1);
      const result = await Q(resolvers, 'patients')(
        null,
        { first: 2, after: afterCursor },
        ctx,
      );

      const queryArgs = queryMock.mock.calls[0]!;
      expect(queryArgs[2]).toEqual(
        expect.objectContaining({ limit: 2, offset: 2 }),
      );

      expect(result.edges).toHaveLength(2);
      expect(result.pageInfo.hasNextPage).toBe(false);
      expect(result.pageInfo.hasPreviousPage).toBe(true);
    });
  });

  describe('availableTools', () => {
    it('returns tool descriptors for all action types', () => {
      const deps = createMockDeps(parsed);
      const { resolvers } = generateResolvers(parsed, deps);
      const ctx = createResolverContext(deps);

      const tools = Q(resolvers, 'availableTools')(null, {}, ctx);

      expect(tools).toHaveLength(2);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const names = tools.map((t: any) => t.name);
      expect(names).toContain('DischargePatient');
      expect(names).toContain('AdmitPatient');
    });

    it('returns correct JSON Schema parameters', () => {
      const deps = createMockDeps(parsed);
      const { resolvers } = generateResolvers(parsed, deps);
      const ctx = createResolverContext(deps);

      const tools = Q(resolvers, 'availableTools')(null, {}, ctx);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const discharge = tools.find((t: any) => t.name === 'DischargePatient');

      expect(discharge).toBeDefined();
      expect(discharge.kind).toBe('ACTION');
      expect(discharge.parameters.properties.patient).toBeDefined();
      expect(discharge.parameters.properties.destination).toBeDefined();
      expect(discharge.parameters.properties.notes).toBeDefined();
      expect(discharge.parameters.required).toContain('patient');
      expect(discharge.parameters.required).toContain('destination');
      expect(discharge.dryRunSupported).toBe(false);
      expect(discharge.requiredPermissions).toEqual(['action:DischargePatient']);
    });

    it('filters by kind', () => {
      const deps = createMockDeps(parsed);
      const { resolvers } = generateResolvers(parsed, deps);
      const ctx = createResolverContext(deps);

      const tools = Q(resolvers, 'availableTools')(
        null,
        { filter: { kind: 'ACTION' } },
        ctx,
      );
      expect(tools).toHaveLength(2);

      const noTools = Q(resolvers, 'availableTools')(
        null,
        { filter: { kind: 'FUNCTION' } },
        ctx,
      );
      expect(noTools).toHaveLength(0);
    });
  });

  describe('aggregate queries', () => {
    it('generates aggregate resolver for each ObjectType', () => {
      const deps = createMockDeps(parsed);
      const { resolvers } = generateResolvers(parsed, deps);
      const query = resolvers['Query']!;

      expect(query['patientAggregate']).toBeTypeOf('function');
      expect(query['wardAggregate']).toBeTypeOf('function');
      expect(query['bedAggregate']).toBeTypeOf('function');
      expect(query['consultantAggregate']).toBeTypeOf('function');
    });

    it('calls objectManager.aggregate with correct params', async () => {
      const deps = createMockDeps(parsed);
      const aggregateMock = vi.fn().mockResolvedValue({
        groups: [{ keys: {}, values: { count: 5 } }],
        totalGroups: 1,
      });
      (deps.objectManager as unknown as Record<string, unknown>).aggregate = aggregateMock;

      const { resolvers } = generateResolvers(parsed, deps);
      const ctx = createResolverContext(deps);

      const result = await Q(resolvers, 'patientAggregate')(
        null,
        {
          fields: [{ field: '*', fn: 'COUNT', alias: 'count' }],
          groupBy: ['status'],
        },
        ctx,
      );

      expect(aggregateMock).toHaveBeenCalledTimes(1);
      const callArgs = aggregateMock.mock.calls[0]!;
      expect(callArgs[0]).toBe('Patient');
      expect(callArgs[1].fields).toEqual([{ field: '*', fn: 'count', alias: 'count' }]);
      expect(callArgs[1].groupBy).toEqual(['status']);
      expect(result.groups).toHaveLength(1);
      expect(result.totalGroups).toBe(1);
    });

    it('converts GraphQL filter to SPI filter', async () => {
      const deps = createMockDeps(parsed);
      const aggregateMock = vi.fn().mockResolvedValue({
        groups: [{ keys: {}, values: { count: 3 } }],
        totalGroups: 1,
      });
      (deps.objectManager as unknown as Record<string, unknown>).aggregate = aggregateMock;

      const { resolvers } = generateResolvers(parsed, deps);
      const ctx = createResolverContext(deps);

      await Q(resolvers, 'patientAggregate')(
        null,
        {
          filter: { status: { eq: 'ACTIVE' } },
          fields: [{ field: '*', fn: 'COUNT', alias: 'count' }],
        },
        ctx,
      );

      const callArgs = aggregateMock.mock.calls[0]!;
      const filter = callArgs[1].filter;
      expect(filter).toBeDefined();
      expect(filter.field).toBe('status');
      expect(filter.operator).toBe('eq');
      expect(filter.value).toBe('ACTIVE');
    });
  });

  describe('consent filtering', () => {
    it('marks consent-restricted objects', async () => {
      const deps = createMockDeps(parsed);
      const patient = createPatientObject('p-1');
      (deps.objectManager.get as ReturnType<typeof vi.fn>).mockResolvedValue(patient);

      deps.consentService = {
        checkSingleObject: vi.fn().mockResolvedValue({
          data: {},
          _consentRestricted: true,
        }),
        filterList: vi.fn(),
        guardAction: vi.fn(),
        checkConsent: vi.fn(),
        recordConsent: vi.fn(),
        getConsentRecord: vi.fn(),
      } as unknown as ApiDependencies['consentService'];

      const { resolvers } = generateResolvers(parsed, deps);
      const ctx = createResolverContext(deps);

      const result = await Q(resolvers, 'patient')(null, { id: 'p-1' }, ctx);

      expect(result._consentRestricted).toBe(true);
      expect(result.nhsNumber).toBeNull();
      expect(result.name).toBeNull();
      expect(result.dateOfBirth).toBeNull();
      expect(result.id).toBe('p-1');
    });

    it('filters list by consent', async () => {
      const deps = createMockDeps(parsed);
      const listMock = deps.authorizationService.listObjects as ReturnType<typeof vi.fn>;
      listMock.mockResolvedValue(['patient:p-1', 'patient:p-2', 'patient:p-3']);

      const queryMock = deps.objectManager.query as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValue({
        items: [
          createPatientObject('p-1'),
          createPatientObject('p-2'),
          createPatientObject('p-3'),
        ],
        totalCount: 3,
        hasNextPage: false,
      });

      deps.consentService = {
        filterList: vi.fn().mockResolvedValue({
          edges: [
            { id: 'p-1', nhsNumber: 'NHS-p-1', name: 'Patient p-1', dateOfBirth: '1990-01-01', status: 'ACTIVE', triageCategory: null, _redactedFields: null, _consentRestricted: false },
            { id: 'p-3', nhsNumber: 'NHS-p-3', name: 'Patient p-3', dateOfBirth: '1990-01-01', status: 'ACTIVE', triageCategory: null, _redactedFields: null, _consentRestricted: false },
          ],
          totalCount: 2,
        }),
        checkSingleObject: vi.fn(),
        guardAction: vi.fn(),
        checkConsent: vi.fn(),
        recordConsent: vi.fn(),
        getConsentRecord: vi.fn(),
      } as unknown as ApiDependencies['consentService'];

      const { resolvers } = generateResolvers(parsed, deps);
      const ctx = createResolverContext(deps);

      const result = await Q(resolvers, 'patients')(null, { first: 10 }, ctx);

      expect(result.totalCount).toBe(2);
      expect(result.edges).toHaveLength(2);
    });
  });

  describe('error handling', () => {
    it('creates OpenFoundry error with extensions', () => {
      const err = createOpenFoundryError({
        code: 'CONSENT_DENIED',
        category: 'consent',
        message: 'Consent denied',
        retryable: false,
        details: { subject: 'p-1' },
        traceId: 'trace-abc',
      });

      expect(err.message).toBe('Consent denied');
      expect(err.extensions?.['openfoundry']).toBeDefined();
      const ext = err.extensions!['openfoundry'] as Record<string, unknown>;
      expect(ext['code']).toBe('CONSENT_DENIED');
      expect(ext['category']).toBe('consent');
      expect(ext['retryable']).toBe(false);
      expect(ext['traceId']).toBe('trace-abc');
    });

    it('wraps unknown errors into OpenFoundry format', () => {
      const err = wrapError(new Error('Something broke'), 'trace-xyz');
      expect(err.extensions?.['openfoundry']).toBeDefined();
      const ext = err.extensions!['openfoundry'] as Record<string, unknown>;
      expect(ext['code']).toBe('INTERNAL_ERROR');
      expect(ext['category']).toBe('system');
    });

    it('preserves GraphQL errors as-is', () => {
      const original = createOpenFoundryError({
        code: 'OBJECT_NOT_FOUND',
        category: 'not_found',
        message: 'Not found',
        retryable: false,
      });

      const wrapped = wrapError(original);
      expect(wrapped).toBe(original);
    });
  });
});

describe('pagination utilities', () => {
  it('encodes and decodes cursor correctly', () => {
    for (const offset of [0, 1, 10, 99, 1000]) {
      const cursor = encodeCursor(offset);
      expect(decodeCursor(cursor)).toBe(offset);
    }
  });

  it('throws on invalid cursor', () => {
    expect(() => decodeCursor('not-a-valid-cursor')).toThrow('Invalid cursor format');
    expect(() => decodeCursor('')).toThrow('Invalid cursor format');
  });

  it('resolves first/after pagination', () => {
    const afterCursor = encodeCursor(4);
    const { offset, limit } = resolvePagination({ first: 10, after: afterCursor });
    expect(offset).toBe(5);
    expect(limit).toBe(10);
  });

  it('uses default page size when first not specified', () => {
    const { limit } = resolvePagination({});
    expect(limit).toBe(20);
  });

  it('caps page size at MAX_PAGE_SIZE', () => {
    const { limit } = resolvePagination({ first: 500 });
    expect(limit).toBe(100);
  });

  it('builds connection with correct structure', () => {
    const items = ['a', 'b', 'c'];
    const conn = buildConnection(items, 10, 5);

    expect(conn.edges).toHaveLength(3);
    expect(conn.edges[0]!.node).toBe('a');
    expect(conn.edges[0]!.cursor).toBe(encodeCursor(5));
    expect(conn.edges[2]!.cursor).toBe(encodeCursor(7));
    expect(conn.totalCount).toBe(10);
    expect(conn.pageInfo.hasNextPage).toBe(true);
    expect(conn.pageInfo.hasPreviousPage).toBe(true);
    expect(conn.pageInfo.startCursor).toBe(encodeCursor(5));
    expect(conn.pageInfo.endCursor).toBe(encodeCursor(7));
  });

  it('builds empty connection', () => {
    const conn = buildConnection([], 0, 0);

    expect(conn.edges).toHaveLength(0);
    expect(conn.totalCount).toBe(0);
    expect(conn.pageInfo.hasNextPage).toBe(false);
    expect(conn.pageInfo.hasPreviousPage).toBe(false);
    expect(conn.pageInfo.startCursor).toBeNull();
    expect(conn.pageInfo.endCursor).toBeNull();
  });
});
