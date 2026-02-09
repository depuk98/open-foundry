/**
 * FHIR R4 read-only router (Section 8.3, MVP item 13).
 *
 * Provides a framework-agnostic request handler that maps incoming HTTP
 * requests to FHIR-formatted responses backed by the Ontology Engine.
 *
 * Endpoints:
 *   GET /fhir/Patient/{id}                              → read
 *   GET /fhir/Patient?identifier=nhs-number|value        → search
 *   GET /fhir/Patient?name=value                         → search
 *   GET /fhir/Patient?birthdate=value                    → search
 *   GET /fhir/Encounter?patient=Patient/{id}             → search
 *   POST/PUT/DELETE any → 405 Method Not Allowed
 *
 * All endpoints pass through the same security pipeline
 * (auth, authz, consent) as the GraphQL layer.
 */

import type { OntologyObject, FilterExpression, FieldPredicate } from '@openfoundry/spi';
import { DataPurpose } from '@openfoundry/spi';
import type { ApiDependencies, AuthenticatedUserInfo } from '../graphql/types.js';
import type {
  FhirResource,
  FhirBundle,
  FhirOperationOutcome,
} from './types.js';
import { mapPatientToFhir, mapEncounterToFhir } from './mappers.js';

// ─── Request / Response types ───

export interface FhirRequest {
  method: string;
  /** Path relative to /fhir/, e.g. "Patient/abc" or "Patient" */
  path: string;
  /** Parsed query string parameters */
  query: Record<string, string>;
  /** Authenticated user from the security pipeline */
  user: AuthenticatedUserInfo;
}

export interface FhirResponse {
  status: number;
  headers: Record<string, string>;
  body: FhirResource | FhirBundle | FhirOperationOutcome;
}

// ─── Configuration ───

export interface FhirRouterConfig {
  deps: ApiDependencies;
  /** Base URL for fullUrl generation in bundles. Defaults to '' */
  baseUrl?: string;
}

// ─── Router factory ───

/**
 * Create a FHIR request handler.
 *
 * Returns a function that routes incoming FHIR requests to the appropriate
 * handler and returns a FHIR-formatted response.
 */
export function createFhirRouter(config: FhirRouterConfig) {
  const { deps, baseUrl = '' } = config;

  return async (req: FhirRequest): Promise<FhirResponse> => {
    // Read-only: reject write methods
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return methodNotAllowed(req.method);
    }

    const segments = req.path.split('/').filter(Boolean);
    const resourceType = segments[0];
    const resourceId = segments[1];

    if (!resourceType) {
      return operationOutcome(400, 'invalid', 'Missing resource type in path');
    }

    switch (resourceType) {
      case 'Patient':
        if (resourceId) {
          return handlePatientRead(deps, req, resourceId);
        }
        return handlePatientSearch(deps, req, baseUrl);

      case 'Encounter':
        return handleEncounterSearch(deps, req, baseUrl);

      default:
        return operationOutcome(404, 'not-found', `Resource type '${resourceType}' is not supported`);
    }
  };
}

// ─── Patient handlers ───

async function handlePatientRead(
  deps: ApiDependencies,
  req: FhirRequest,
  id: string,
): Promise<FhirResponse> {
  // Authorization check
  const allowed = await deps.authorizationService.check(
    `user:${req.user.id}`,
    'viewer',
    `patient:${id}`,
  );
  if (!allowed) {
    return operationOutcome(403, 'forbidden', `Access denied to Patient ${id}`);
  }

  const ctx = {
    tenantId: req.user.tenantId,
    actorId: req.user.id,
    traceId: `fhir-${Date.now()}`,
  };

  const obj = await deps.objectManager.get('Patient', id, ctx);
  if (!obj) {
    return operationOutcome(404, 'not-found', `Patient/${id} not found`);
  }

  // Field-level redaction
  const { data } = deps.authorizationService.redactFields(
    req.user.id,
    req.user.roles,
    'Patient',
    obj as unknown as Record<string, unknown>,
  );

  // Consent check (if service available)
  if (deps.consentService) {
    const consent = await deps.consentService.checkSingleObject(
      data,
      id,
      DataPurpose.DIRECT_CARE,
      req.user.id,
    );
    if (consent._consentRestricted) {
      return operationOutcome(403, 'forbidden', 'Consent denied for this patient');
    }
  }

  const patient = mapPatientToFhir(data as unknown as OntologyObject);

  return {
    status: 200,
    headers: fhirHeaders(),
    body: patient,
  };
}

async function handlePatientSearch(
  deps: ApiDependencies,
  req: FhirRequest,
  baseUrl: string,
): Promise<FhirResponse> {
  const ctx = {
    tenantId: req.user.tenantId,
    actorId: req.user.id,
    traceId: `fhir-${Date.now()}`,
  };

  // Build filter from FHIR search parameters
  const searchFilter = buildPatientFilter(req.query);
  if (!searchFilter) {
    return operationOutcome(400, 'invalid', 'At least one search parameter is required (identifier, name, birthdate)');
  }

  // Authorization: get list of patients user can view
  const allowedObjects = await deps.authorizationService.listObjects(
    `user:${req.user.id}`,
    'viewer',
    'patient',
  );

  const allowedIds = allowedObjects.map((o: string) => o.replace('patient:', ''));

  // Combine authorization filter with search filter
  const idFilter: FieldPredicate = { field: '_id', operator: 'in', value: allowedIds };
  const combinedFilter: FilterExpression = {
    and: [idFilter, searchFilter],
  };

  const page = await deps.objectManager.query(
    'Patient',
    combinedFilter,
    { limit: 100, offset: 0 },
    ctx,
  );

  // Redact fields for all results
  const redacted = deps.authorizationService.redactFieldsBatch(
    req.user.id,
    req.user.roles,
    'Patient',
    page.items as unknown as Record<string, unknown>[],
  );

  const entries = redacted.map((r: { data: Record<string, unknown> }) => {
    const patient = mapPatientToFhir(r.data as unknown as OntologyObject);
    return {
      fullUrl: baseUrl ? `${baseUrl}/fhir/Patient/${patient.id}` : undefined,
      resource: patient,
    };
  });

  const bundle: FhirBundle = {
    resourceType: 'Bundle',
    type: 'searchset',
    total: entries.length,
    entry: entries.length > 0 ? entries : undefined,
  };

  return {
    status: 200,
    headers: fhirHeaders(),
    body: bundle,
  };
}

// ─── Encounter handlers ───

async function handleEncounterSearch(
  deps: ApiDependencies,
  req: FhirRequest,
  baseUrl: string,
): Promise<FhirResponse> {
  const patientParam = req.query['patient'];
  if (!patientParam) {
    return operationOutcome(400, 'invalid', 'The "patient" search parameter is required for Encounter search');
  }

  // Extract patient ID from "Patient/{id}" format
  const patientId = patientParam.replace(/^Patient\//, '');

  const ctx = {
    tenantId: req.user.tenantId,
    actorId: req.user.id,
    traceId: `fhir-${Date.now()}`,
  };

  // Authorization: check user can view this patient
  const allowed = await deps.authorizationService.check(
    `user:${req.user.id}`,
    'viewer',
    `patient:${patientId}`,
  );
  if (!allowed) {
    return operationOutcome(403, 'forbidden', `Access denied to Patient ${patientId}`);
  }

  // Query encounters linked to this patient
  const filter: FieldPredicate = { field: 'patientId', operator: 'eq', value: patientId };

  const page = await deps.objectManager.query(
    'Encounter',
    filter,
    { limit: 100, offset: 0 },
    ctx,
  );

  const entries = page.items.map((obj) => {
    const encounter = mapEncounterToFhir(obj, patientId);
    return {
      fullUrl: baseUrl ? `${baseUrl}/fhir/Encounter/${encounter.id}` : undefined,
      resource: encounter,
    };
  });

  const bundle: FhirBundle = {
    resourceType: 'Bundle',
    type: 'searchset',
    total: entries.length,
    entry: entries.length > 0 ? entries : undefined,
  };

  return {
    status: 200,
    headers: fhirHeaders(),
    body: bundle,
  };
}

// ─── Search filter builders ───

/**
 * Build an SPI FilterExpression from FHIR Patient search parameters.
 *
 * Supported parameters:
 *   - identifier: system|value format (e.g. "nhs-number|1234567890" or full system URI)
 *   - name: string match on name field
 *   - birthdate: exact match on dateOfBirth field
 */
export function buildPatientFilter(
  query: Record<string, string>,
): FilterExpression | null {
  const conditions: FieldPredicate[] = [];

  if (query['identifier']) {
    const identifier = query['identifier'];
    // Format: system|value or just value
    const pipeIndex = identifier.indexOf('|');
    if (pipeIndex >= 0) {
      const value = identifier.substring(pipeIndex + 1);
      conditions.push({ field: 'nhsNumber', operator: 'eq', value });
    } else {
      conditions.push({ field: 'nhsNumber', operator: 'eq', value: identifier });
    }
  }

  if (query['name']) {
    conditions.push({ field: 'name', operator: 'contains', value: query['name'] });
  }

  if (query['birthdate']) {
    conditions.push({ field: 'dateOfBirth', operator: 'eq', value: query['birthdate'] });
  }

  if (conditions.length === 0) return null;
  if (conditions.length === 1) return conditions[0]!;
  return { and: conditions };
}

// ─── Helpers ───

function fhirHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/fhir+json; charset=utf-8',
  };
}

function methodNotAllowed(method: string): FhirResponse {
  return {
    status: 405,
    headers: {
      ...fhirHeaders(),
      Allow: 'GET, HEAD',
    },
    body: {
      resourceType: 'OperationOutcome',
      issue: [
        {
          severity: 'error',
          code: 'not-supported',
          diagnostics: `Method ${method} is not allowed. This FHIR endpoint is read-only.`,
        },
      ],
    },
  };
}

function operationOutcome(
  status: number,
  code: string,
  diagnostics: string,
): FhirResponse {
  return {
    status,
    headers: fhirHeaders(),
    body: {
      resourceType: 'OperationOutcome',
      issue: [
        {
          severity: 'error',
          code,
          diagnostics,
        },
      ],
    },
  };
}
