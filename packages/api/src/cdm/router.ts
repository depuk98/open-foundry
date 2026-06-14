/**
 * FDP/CDM read-only projection router (Stage 1 item S1.0).
 *
 * Emits the Open Foundry operational ontology in CDM shape, driven by the
 * mapping profile. Read-only; passes through the same auth / redaction /
 * consent pipeline as the FHIR and GraphQL layers.
 *
 * Endpoints (addressed by Open Foundry source type for unambiguous routing;
 * each record's `resourceType` carries the CDM resource name):
 *   GET /api/v1/cdm/metadata                  → profile + compatibility matrix + gap register
 *   GET /api/v1/cdm/{SourceType}              → list projection (object-kind)
 *   GET /api/v1/cdm/{SourceType}/{id}         → single projection (object-kind)
 *   GET /api/v1/cdm/Encounter?patient={id}    → admission projection (link-kind, via AdmittedTo)
 */

import type { FilterExpression, FieldPredicate } from '@openfoundry/spi';
import { DataPurpose } from '@openfoundry/spi';
import type { ApiDependencies, AuthenticatedUserInfo } from '../graphql/types.js';
import { logger } from '../logger.js';
import { toSnakeCase } from '../utils.js';
import { NHS_ACUTE_CDM_PROFILE } from './profile.js';
import { projectToCdm, findMappingBySourceType } from './mappers.js';
import type { CdmRecord } from './types.js';

export interface CdmRequest {
  method: string;
  /** Path relative to /api/v1/cdm/, e.g. "Patient/abc" or "Patient". */
  path: string;
  query: Record<string, string>;
  /** Authenticated user; undefined for the public metadata endpoint. */
  user?: AuthenticatedUserInfo;
}

export interface CdmResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface CdmRouterConfig {
  deps: ApiDependencies;
}

const QUERY_LIMIT = 100;

function jsonHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json; charset=utf-8' };
}

function error(status: number, message: string): CdmResponse {
  return { status, headers: jsonHeaders(), body: { error: { code: status, message } } };
}

/** Object-kind source types exposed via list/by-id routes. */
export const OBJECT_SOURCE_TYPES = NHS_ACUTE_CDM_PROFILE.resources
  .filter(r => r.sourceKind === 'object')
  .map(r => r.sourceType);

/**
 * Build the public CDM metadata body (profile + compatibility matrix + gap
 * register). Shared by the REST router and the GraphQL cdmMetadata resolver.
 */
export function buildCdmMetadata(): Record<string, unknown> {
  const profile = NHS_ACUTE_CDM_PROFILE;
  return {
    profileVersion: profile.profileVersion,
    cdmVersion: profile.cdmVersion,
    cdmStatus: profile.cdmStatus,
    subset: profile.subset,
    resources: profile.resources.map(r => ({
      cdmResource: r.cdmResource,
      sourceType: r.sourceType,
      sourceKind: r.sourceKind,
      note: r.note,
      fields: r.fields,
    })),
    gaps: profile.gaps,
  };
}

export function createCdmRouter(config: CdmRouterConfig) {
  const { deps } = config;

  return async (req: CdmRequest): Promise<CdmResponse> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return error(405, 'The CDM projection is read-only.');
    }

    const segments = req.path.split('/').filter(Boolean);
    const head = segments[0];
    const id = segments[1];

    if (!head) {
      return error(400, 'Missing CDM resource in path.');
    }

    // Public metadata: profile, compatibility matrix, gap register.
    if (head === 'metadata') {
      return {
        status: 200,
        headers: jsonHeaders(),
        body: buildCdmMetadata(),
      };
    }

    // All data endpoints require authentication.
    if (!req.user || !req.user.id || !req.user.tenantId) {
      return error(401, 'Authentication required.');
    }

    // Encounter is link-kind (derived from AdmittedTo), addressed by ?patient.
    if (head === 'Encounter') {
      return handleEncounterSearch(deps, req, req.user);
    }

    // Object-kind resources.
    if (!OBJECT_SOURCE_TYPES.includes(head)) {
      return error(404, `CDM source type '${head}' is not exposed. Known: ${OBJECT_SOURCE_TYPES.join(', ')}, Encounter.`);
    }

    return id
      ? handleObjectRead(deps, req.user, head, id)
      : handleObjectList(deps, req.user, head);
  };
}

function ctxFor(user: AuthenticatedUserInfo) {
  return { tenantId: user.tenantId, actorId: user.id, traceId: `cdm-${Date.now()}` };
}

/** Patient is the consent subject; other types are not consent-gated here. */
function isConsentSubject(sourceType: string): boolean {
  return sourceType === 'Patient';
}

export async function handleObjectRead(
  deps: ApiDependencies,
  user: AuthenticatedUserInfo,
  sourceType: string,
  id: string,
): Promise<CdmResponse> {
  try {
    // FGA type names are snake_case (matches ODL→OpenFGA codegen + nhs-roles.fga,
    // e.g. DischargeRecord → discharge_record).
    const fgaType = toSnakeCase(sourceType);
    const allowed = await deps.authorizationService.check(`user:${user.id}`, 'viewer', `${fgaType}:${id}`);
    if (!allowed) return error(403, `Access denied to ${sourceType} ${id}`);

    const ctx = ctxFor(user);
    const obj = await deps.objectManager.get(sourceType, id, ctx);
    if (!obj) return error(404, `${sourceType}/${id} not found`);

    const { data } = deps.authorizationService.redactFields(
      user.id, user.roles, sourceType, obj as unknown as Record<string, unknown>,
    );

    if (deps.consentService && isConsentSubject(sourceType)) {
      const consent = await deps.consentService.checkSingleObject(
        data, id, DataPurpose.DIRECT_CARE, user.id, user.tenantId,
      );
      if (consent._consentRestricted) return error(403, 'Consent denied for this record.');
    }

    const mapping = findMappingBySourceType(NHS_ACUTE_CDM_PROFILE, sourceType)!;
    const record = projectToCdm(data as Record<string, unknown>, mapping, NHS_ACUTE_CDM_PROFILE);
    return { status: 200, headers: jsonHeaders(), body: record };
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'unknown' }, 'CDM object read error');
    return error(500, 'Internal server error');
  }
}

export async function handleObjectList(
  deps: ApiDependencies,
  user: AuthenticatedUserInfo,
  sourceType: string,
): Promise<CdmResponse> {
  try {
    const ctx = ctxFor(user);
    const mapping = findMappingBySourceType(NHS_ACUTE_CDM_PROFILE, sourceType)!;
    const fgaType = toSnakeCase(sourceType);
    const allowedObjects = await deps.authorizationService.listObjects(`user:${user.id}`, 'viewer', fgaType);

    // '*' sentinel (dev stub / unrestricted) → no id filter; otherwise restrict.
    const unrestricted = allowedObjects.includes('*');
    const allowedIds = unrestricted
      ? []
      : allowedObjects
          .map(o => o.split(':').pop())
          .filter((v): v is string => !!v);

    if (!unrestricted && allowedIds.length === 0) {
      // Empty result still advertises the CDM resource name (not the OF source type).
      return { status: 200, headers: jsonHeaders(), body: { resourceType: mapping.cdmResource, total: 0, records: [] } };
    }

    // Match-all pass-through (also excludes soft-deleted) mirrors the REST
    // route generator; when restricted, filter by the authorized id set.
    const filter: FilterExpression = unrestricted
      ? ({ field: '_deleted_at', operator: 'exists', value: false } as FieldPredicate)
      : ({ field: '_id', operator: 'in', value: allowedIds } as FieldPredicate);

    const page = await deps.objectManager.query(
      sourceType,
      filter,
      { limit: QUERY_LIMIT, offset: 0 },
      ctx,
    );

    const redacted = deps.authorizationService.redactFieldsBatch(
      user.id, user.roles, sourceType, page.items as unknown as Record<string, unknown>[],
    );

    let rows = redacted.map(r => r.data);

    if (deps.consentService && isConsentSubject(sourceType)) {
      const consentResult = await deps.consentService.filterList(
        rows,
        (item: Record<string, unknown>) => String(item['_id'] ?? item['id'] ?? ''),
        DataPurpose.DIRECT_CARE, user.id, user.tenantId,
      );
      rows = consentResult.edges as Record<string, unknown>[];
    }

    const records: CdmRecord[] = rows.map(r => projectToCdm(r, mapping, NHS_ACUTE_CDM_PROFILE));

    return {
      status: 200,
      headers: jsonHeaders(),
      body: { resourceType: mapping.cdmResource, total: records.length, records },
    };
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'unknown' }, 'CDM object list error');
    return error(500, 'Internal server error');
  }
}

async function handleEncounterSearch(
  deps: ApiDependencies,
  req: CdmRequest,
  user: AuthenticatedUserInfo,
): Promise<CdmResponse> {
  try {
    const patientParam = req.query['patient'];
    if (!patientParam) {
      return error(400, 'The "patient" query parameter is required for Encounter projection.');
    }
    const patientId = patientParam.replace(/^Patient\//, '');
    if (!patientId) return error(400, 'Invalid patient reference.');

    const allowed = await deps.authorizationService.check(`user:${user.id}`, 'viewer', `patient:${patientId}`);
    if (!allowed) return error(403, `Access denied to Patient ${patientId}`);

    const ctx = ctxFor(user);
    // includeDeleted so discharged admissions (soft-deleted AdmittedTo links)
    // are returned and mapped to status=finished. (Postgres soft-deletes links;
    // the memory provider hard-deletes, so finished encounters are only
    // recoverable on the Postgres backend.)
    const linkPage = await deps.linkManager.getLinks(
      patientId, 'AdmittedTo', 'outbound', { limit: QUERY_LIMIT, offset: 0, includeDeleted: true }, ctx,
    );

    // Flatten links to object shape for the profile-driven projection
    // (same approach as the FHIR Encounter path).
    const encounterObjects = linkPage.items.map(link => ({
      _id: link._id,
      _version: link._version,
      _updatedAt: link._updatedAt,
      patientId,
      wardId: link._toId,
      admissionDate: link.admissionDate,
      expectedDischarge: link.expectedDischarge,
      reason: link.reason,
      status: link._deletedAt ? 'DISCHARGED' : 'ACTIVE',
    })) as unknown as Record<string, unknown>[];

    let rows = encounterObjects;
    if (deps.consentService) {
      const consentResult = await deps.consentService.filterList(
        rows, () => patientId, DataPurpose.DIRECT_CARE, user.id, user.tenantId,
      );
      rows = consentResult.edges as Record<string, unknown>[];
    }

    const mapping = findMappingBySourceType(NHS_ACUTE_CDM_PROFILE, 'AdmittedTo')!;
    const records: CdmRecord[] = rows.map(r => projectToCdm(r, mapping, NHS_ACUTE_CDM_PROFILE));

    return {
      status: 200,
      headers: jsonHeaders(),
      body: { resourceType: 'Encounter', total: records.length, records },
    };
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : 'unknown' }, 'CDM Encounter search error');
    return error(500, 'Internal server error');
  }
}
