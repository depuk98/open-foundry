/**
 * Auto-generated REST route factory (Section 8.2).
 *
 * Takes a ParsedSchema and ApiDependencies, produces REST route definitions.
 * Each ObjectType gets:
 *   GET  /api/v1/{plural}            — list with query params
 *   GET  /api/v1/{plural}/:id        — get by ID
 *   GET  /api/v1/{plural}/:id/links/:linkType — linked objects
 *   GET  /api/v1/{plural}/:id/history — version history
 *
 * Each ActionType gets:
 *   POST /api/v1/actions/{ActionName} — execute action
 *
 * All routes go through the same security pipeline (auth, authz, consent)
 * as the GraphQL layer. Error responses use the unified error model (Section 8.8).
 */

import type { ParsedSchema, ObjectType, ActionType, FieldDefinition } from '@openfoundry/odl';
import type { OntologyObject, FilterExpression, DataPurpose } from '@openfoundry/spi';
import type { ActionActor, ActionContext } from '@openfoundry/actions';
import type { RedactionResult } from '@openfoundry/security';
import type { ApiDependencies, ResolverContext } from '../graphql/types.js';
import { DEFAULT_CONSENT_PURPOSE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../graphql/types.js';
import type { RestRequest, RestResponse, RestRoute } from './types.js';
import { createRestErrorResponse, wrapErrorToRest } from './errors.js';

// ─── Helpers ───

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** Convert PascalCase to snake_case — must match FGA codegen convention. */
function toSnakeCase(s: string): string {
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

function pluralize(s: string): string {
  return lowerFirst(s) + 's';
}

function isPrimaryField(field: FieldDefinition): boolean {
  return field.directives.some(d => d.kind === 'primary');
}

/**
 * Convert an OntologyObject to a REST-friendly shape.
 * Same logic as GraphQL objectToGraphQL.
 */
function objectToRest(obj: OntologyObject, objectType: ObjectType): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const field of objectType.fields) {
    if (isPrimaryField(field)) {
      result[field.name] = obj[`_${field.name}`] ?? obj[field.name];
    } else {
      result[field.name] = obj[field.name];
    }
  }

  result._redactedFields = null;
  result._consentRestricted = false;

  return result;
}

/**
 * Parse REST query params into a FilterExpression.
 * Supports filter[field]=value format for simple equality filters.
 */
function parseQueryFilter(query: Record<string, string | string[] | undefined>): FilterExpression | undefined {
  const predicates: FilterExpression[] = [];

  for (const [key, value] of Object.entries(query)) {
    if (value == null) continue;
    const match = key.match(/^filter\[(\w+)\]$/);
    if (match && match[1]) {
      const fieldName = match[1];
      const fieldValue = Array.isArray(value) ? value[0] : value;
      predicates.push({ field: fieldName, operator: 'eq', value: fieldValue });
    }
  }

  if (predicates.length === 0) return undefined;
  if (predicates.length === 1) return predicates[0];
  return { and: predicates };
}

/**
 * Parse pagination from query params.
 */
function parsePagination(query: Record<string, string | string[] | undefined>): { offset: number; limit: number } {
  const limitStr = typeof query['limit'] === 'string' ? query['limit'] : undefined;
  const offsetStr = typeof query['offset'] === 'string' ? query['offset'] : undefined;

  const limit = Math.min(
    limitStr ? parseInt(limitStr, 10) || DEFAULT_PAGE_SIZE : DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
  );
  const offset = offsetStr ? parseInt(offsetStr, 10) || 0 : 0;

  return { offset, limit };
}

// ─── Public API ───

/**
 * Generate REST route definitions from ParsedSchema and dependencies.
 */
export function generateRestRoutes(
  schema: ParsedSchema,
  deps: ApiDependencies,
): RestRoute[] {
  const routes: RestRoute[] = [];

  for (const obj of schema.objectTypes) {
    routes.push(...generateObjectRoutes(obj, deps));
  }

  for (const action of schema.actionTypes) {
    routes.push(generateActionRoute(action, schema, deps));
  }

  return routes;
}

// ─── Object routes ───

function generateObjectRoutes(
  obj: ObjectType,
  deps: ApiDependencies,
): RestRoute[] {
  const plural = pluralize(obj.name);
  const fgaType = toSnakeCase(obj.name);

  return [
    generateListRoute(obj, plural, fgaType, deps),
    generateGetByIdRoute(obj, plural, fgaType, deps),
    generateLinksRoute(plural, fgaType, deps),
    generateHistoryRoute(obj, plural, fgaType, deps),
  ];
}

/**
 * GET /api/v1/{plural} — list with query params for filtering and pagination.
 */
function generateListRoute(
  obj: ObjectType,
  plural: string,
  fgaType: string,
  deps: ApiDependencies,
): RestRoute {
  return {
    method: 'GET',
    pattern: `/api/v1/${plural}`,
    handler: async (req: RestRequest, ctx: ResolverContext): Promise<RestResponse> => {
      try {
        const { user, requestContext } = ctx;
        const typeName = obj.name;

        // Authorization: list objects user can see
        const allowedObjects = await deps.authorizationService.listObjects(
          `user:${user.id}`,
          'viewer',
          fgaType,
        );

        const allowedIds = allowedObjects.map((o: string) => {
          const parts = o.split(':');
          return parts[parts.length - 1];
        }).filter((id): id is string => id !== undefined && id !== '');

        // SEC-10: If no objects are authorized, return empty result immediately
        if (allowedIds.length === 0) {
          return {
            status: 200,
            body: {
              data: [],
              pagination: { totalCount: 0, limit: parsePagination(req.query).limit, offset: 0, hasNextPage: false, hasPreviousPage: false },
            },
          };
        }

        const idFilter: FilterExpression = {
          field: '_id',
          operator: 'in',
          value: allowedIds,
        };

        const userFilter = parseQueryFilter(req.query);
        const combinedFilter: FilterExpression = userFilter
          ? { and: [idFilter, userFilter] }
          : idFilter;

        const { offset, limit } = parsePagination(req.query);

        const page = await deps.objectManager.query(
          typeName,
          combinedFilter,
          { limit, offset },
          requestContext,
        );

        // Field-level redaction
        const redactedItems = deps.authorizationService.redactFieldsBatch(
          user.id,
          user.roles,
          typeName,
          page.items.map((item: OntologyObject) => objectToRest(item, obj)),
        );

        let items = redactedItems.map((r: RedactionResult<Record<string, unknown>>) => {
          const data = r.data as Record<string, unknown>;
          data._redactedFields = r._redactedFields.length > 0 ? r._redactedFields : null;
          data._consentRestricted = false;
          return data;
        });

        // Consent filtering (applied after pagination — see FHIR router for details)
        let totalCount = page.totalCount;
        if (deps.consentService) {
          const getPrimaryId = (item: Record<string, unknown>) => {
            const primaryField = obj.fields.find(f => isPrimaryField(f));
            return String(item[primaryField?.name ?? 'id'] ?? '');
          };
          const consentResult = await deps.consentService.filterList(
            items,
            getPrimaryId,
            DEFAULT_CONSENT_PURPOSE as DataPurpose,
            user.id,
          );
          items = consentResult.edges;
          totalCount = consentResult.totalCount;
        }

        return {
          status: 200,
          body: {
            data: items,
            pagination: {
              totalCount,
              limit,
              offset,
              hasNextPage: offset + items.length < totalCount,
              hasPreviousPage: offset > 0,
            },
          },
        };
      } catch (err) {
        return wrapErrorToRest(err, ctx.requestContext.traceId);
      }
    },
  };
}

/**
 * GET /api/v1/{plural}/:id — get single object by ID.
 */
function generateGetByIdRoute(
  obj: ObjectType,
  plural: string,
  fgaType: string,
  deps: ApiDependencies,
): RestRoute {
  return {
    method: 'GET',
    pattern: `/api/v1/${plural}/:id`,
    handler: async (req: RestRequest, ctx: ResolverContext): Promise<RestResponse> => {
      try {
        const { user, requestContext } = ctx;
        const typeName = obj.name;
        const id = req.params['id']!;

        // Authorize
        const allowed = await deps.authorizationService.check(
          `user:${user.id}`,
          'viewer',
          `${fgaType}:${id}`,
        );
        if (!allowed) {
          return createRestErrorResponse({
            code: 'FORBIDDEN',
            category: 'authorization',
            message: `Access denied to ${typeName} ${id}`,
            retryable: false,
            traceId: requestContext.traceId,
          });
        }

        // Get from engine
        const result = await deps.objectManager.get(typeName, id, requestContext);
        if (!result) {
          return createRestErrorResponse({
            code: 'OBJECT_NOT_FOUND',
            category: 'not_found',
            message: `${typeName} ${id} not found`,
            retryable: false,
            traceId: requestContext.traceId,
          });
        }

        let restObj = objectToRest(result, obj);

        // Field-level redaction
        const redacted = deps.authorizationService.redactFields(
          user.id,
          user.roles,
          typeName,
          restObj,
        );
        restObj = redacted.data as Record<string, unknown>;
        restObj._redactedFields = redacted._redactedFields.length > 0 ? redacted._redactedFields : null;

        // Consent filtering
        if (deps.consentService) {
          const consentResult = await deps.consentService.checkSingleObject(
            restObj,
            id,
            DEFAULT_CONSENT_PURPOSE as DataPurpose,
            user.id,
          );
          if (consentResult._consentRestricted) {
            restObj._consentRestricted = true;
            for (const field of obj.fields) {
              if (!isPrimaryField(field)) {
                restObj[field.name] = null;
              }
            }
          }
        }

        return {
          status: 200,
          body: { data: restObj },
        };
      } catch (err) {
        return wrapErrorToRest(err, ctx.requestContext.traceId);
      }
    },
  };
}

/**
 * GET /api/v1/{plural}/:id/links/:linkType — linked objects.
 */
function generateLinksRoute(
  plural: string,
  fgaType: string,
  deps: ApiDependencies,
): RestRoute {
  return {
    method: 'GET',
    pattern: `/api/v1/${plural}/:id/links/:linkType`,
    handler: async (req: RestRequest, ctx: ResolverContext): Promise<RestResponse> => {
      try {
        const { user, requestContext } = ctx;
        const id = req.params['id']!;
        const linkType = req.params['linkType']!;

        // Authorize — user must have view access to the parent object
        const allowed = await deps.authorizationService.check(
          `user:${user.id}`,
          'viewer',
          `${fgaType}:${id}`,
        );
        if (!allowed) {
          return createRestErrorResponse({
            code: 'FORBIDDEN',
            category: 'authorization',
            message: `Access denied to ${plural} ${id}`,
            retryable: false,
            traceId: requestContext.traceId,
          });
        }

        const { offset, limit } = parsePagination(req.query);
        const direction = (req.query['direction'] as string) || 'outbound';

        const linkPage = await deps.linkManager.getLinks(
          id,
          linkType,
          direction as 'inbound' | 'outbound',
          { limit, offset },
          requestContext,
        );

        // Field-level redaction on link properties
        const redacted = deps.authorizationService.redactFieldsBatch(
          user.id,
          user.roles,
          linkType,
          linkPage.items as unknown as Record<string, unknown>[],
        );
        const data = redacted.map((r: { data: Record<string, unknown> }) => r.data);

        return {
          status: 200,
          body: {
            data,
            pagination: {
              totalCount: linkPage.totalCount,
              limit,
              offset,
              hasNextPage: linkPage.hasNextPage,
              hasPreviousPage: offset > 0,
            },
          },
        };
      } catch (err) {
        return wrapErrorToRest(err, ctx.requestContext.traceId);
      }
    },
  };
}

/**
 * GET /api/v1/{plural}/:id/history — version history.
 */
function generateHistoryRoute(
  obj: ObjectType,
  plural: string,
  fgaType: string,
  deps: ApiDependencies,
): RestRoute {
  return {
    method: 'GET',
    pattern: `/api/v1/${plural}/:id/history`,
    handler: async (req: RestRequest, ctx: ResolverContext): Promise<RestResponse> => {
      try {
        const { user, requestContext } = ctx;
        const typeName = obj.name;
        const id = req.params['id']!;

        // Authorize — user must have view access to the object
        const allowed = await deps.authorizationService.check(
          `user:${user.id}`,
          'viewer',
          `${fgaType}:${id}`,
        );
        if (!allowed) {
          return createRestErrorResponse({
            code: 'FORBIDDEN',
            category: 'authorization',
            message: `Access denied to ${typeName} ${id}`,
            retryable: false,
            traceId: requestContext.traceId,
          });
        }

        // Get current object to determine version count
        const current = await deps.objectManager.get(typeName, id, requestContext);
        if (!current) {
          return createRestErrorResponse({
            code: 'OBJECT_NOT_FOUND',
            category: 'not_found',
            message: `${typeName} ${id} not found`,
            retryable: false,
            traceId: requestContext.traceId,
          });
        }

        const currentVersion = (current._version as number) ?? 1;
        const versions: OntologyObject[] = [];

        for (let v = 1; v <= currentVersion; v++) {
          const versionObj = await deps.storage.getObjectAtVersion(
            requestContext,
            typeName,
            id,
            v,
          );
          if (versionObj) {
            versions.push(versionObj);
          }
        }

        // Field-level redaction on each version, preserving version metadata
        const redacted = deps.authorizationService.redactFieldsBatch(
          user.id,
          user.roles,
          typeName,
          versions.map((item: OntologyObject) => objectToRest(item, obj)),
        );

        let items = redacted.map((r: RedactionResult<Record<string, unknown>>, i: number) => {
          const data = r.data as Record<string, unknown>;
          // Preserve version metadata for history entries
          data._version = versions[i]?._version;
          data._updatedAt = versions[i]?._updatedAt;
          data._redactedFields = r._redactedFields.length > 0 ? r._redactedFields : null;
          data._consentRestricted = false;
          return data;
        });

        // Consent filtering
        if (deps.consentService) {
          const getPrimaryId = (item: Record<string, unknown>) => {
            const primaryField = obj.fields.find(f => isPrimaryField(f));
            return String(item[primaryField?.name ?? 'id'] ?? '');
          };
          const consentResult = await deps.consentService.filterList(
            items,
            getPrimaryId,
            DEFAULT_CONSENT_PURPOSE as DataPurpose,
            user.id,
          );
          items = consentResult.edges;
        }

        return {
          status: 200,
          body: {
            data: items,
          },
        };
      } catch (err) {
        return wrapErrorToRest(err, ctx.requestContext.traceId);
      }
    },
  };
}

// ─── Action routes ───

/**
 * POST /api/v1/actions/{ActionName} — execute action.
 */
function generateActionRoute(
  action: ActionType,
  schema: ParsedSchema,
  deps: ApiDependencies,
): RestRoute {
  return {
    method: 'POST',
    pattern: `/api/v1/actions/${action.name}`,
    handler: async (req: RestRequest, ctx: ResolverContext): Promise<RestResponse> => {
      try {
        const { user, requestContext } = ctx;
        const input = (req.body ?? {}) as Record<string, unknown>;

        const actor: ActionActor = {
          id: user.id,
          type: 'user',
          roles: user.roles,
        };

        const actionCtx: ActionContext = {
          requestContext,
        };

        // Resolve manifest from registry — fail closed if not found
        const manifest = deps.manifestRegistry?.get(action.name);
        if (!manifest) {
          return {
            status: 400,
            body: {
              error: {
                code: 'MANIFEST_NOT_FOUND',
                message: `No manifest registered for action "${action.name}"`,
              },
            },
          };
        }

        const result = await deps.actionExecutor.execute(
          manifest,
          input,
          actor,
          actionCtx,
          schema,
        );

        return {
          status: 200,
          body: {
            data: {
              success: result.success,
              actionId: result.actionId,
              errors: result.errors.length > 0 ? result.errors : null,
              affectedObjects: result.affectedObjects.map(o => ({
                typeName: o.type,
                id: o.id,
                changeType: o.changeType.toUpperCase(),
              })),
            },
          },
        };
      } catch (err) {
        return wrapErrorToRest(err, ctx.requestContext.traceId);
      }
    },
  };
}
