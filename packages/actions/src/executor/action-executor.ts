/**
 * Action execution pipeline (Section 5.3).
 *
 * Pipeline order:
 *   Validate -> Authorise -> Consent -> Preconditions -> Execute -> Side-effects -> Audit -> Emit
 *
 * Effects execute in manifest order within a single SPI transaction.
 * CEL expressions are evaluated against an immutable context captured before
 * the first effect. If any effect fails, the transaction is rolled back.
 */

import type {
  OntologyObject,
  OntologyLink,
  Transaction,
  RequestContext,
  DateTime,
} from '@openfoundry/spi';
import type { ParsedSchema, ActionType } from '@openfoundry/odl';
import type {
  ActionManifest,
  ActionEffect,
  UpdateObjectEffect,
  CreateLinkEffect,
  DeleteLinkEffect,
  CreateObjectEffect,
} from '../parser/types.js';
import type {
  ActionActor,
  ActionContext,
  ActionResult,
  ActionError,
  AffectedObject,
  ActionExecutorConfig,
} from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _actionCounter = 0;

function generateActionId(): string {
  return `act_${Date.now().toString(36)}_${(++_actionCounter).toString(36)}`;
}

function now(): DateTime {
  return new Date().toISOString() as DateTime;
}

function failResult(actionId: string, errors: ActionError[]): ActionResult {
  return { success: false, actionId, errors, affectedObjects: [] };
}

/** System field prefixes that storage manages internally. */
const SYSTEM_FIELD_PREFIXES = new Set([
  '_id', '_tenantId', '_version', '_createdAt', '_updatedAt', '_deletedAt',
  '_type', '_fromId', '_toId', '_fromType', '_toType',
]);

/**
 * Strip system fields from an object snapshot before using it in compensation.
 * Storage providers manage these fields internally; including them in an
 * updateObject() call can cause column-mapping errors.
 */
function stripSystemFields(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!SYSTEM_FIELD_PREFIXES.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// ActionExecutor
// ---------------------------------------------------------------------------

export class ActionExecutor {
  private readonly config: ActionExecutorConfig;

  constructor(config: ActionExecutorConfig) {
    this.config = config;
  }

  /**
   * Execute an action against the storage provider.
   *
   * @param manifest  - Parsed action manifest
   * @param params    - Action parameters (param name -> value or object ID)
   * @param actor     - The actor executing the action
   * @param ctx       - Execution context (tenant, consent, etc.)
   * @param schema    - Parsed ODL schema for param resolution
   */
  async execute(
    manifest: ActionManifest,
    params: Record<string, unknown>,
    actor: ActionActor,
    ctx: ActionContext,
    schema: ParsedSchema,
  ): Promise<ActionResult> {
    const actionId = generateActionId();
    const actionType = manifest.action;
    const reqCtx = ctx.requestContext;

    // Find the action type definition in the schema
    const actionTypeDef = schema.actionTypes.find(
      (at) => at.name === actionType,
    );

    // ------------------------------------------------------------------
    // Step 1: VALIDATE — schema validation of params
    // ------------------------------------------------------------------
    const validationErrors = this.validateParams(actionTypeDef, params);
    if (validationErrors.length > 0) {
      return failResult(actionId, validationErrors);
    }

    // ------------------------------------------------------------------
    // Step 2: AUTHORISE — call SecurityLayer.checkPermission
    // ------------------------------------------------------------------
    const permResult = await this.config.security.checkPermission(
      actor,
      actionType,
      params,
      reqCtx,
    );
    if (!permResult.allowed) {
      return failResult(actionId, [
        {
          code: 'AUTHORIZATION_DENIED',
          message: permResult.reason ?? `Actor ${actor.id} is not authorized to execute ${actionType}`,
        },
      ]);
    }

    // ------------------------------------------------------------------
    // Step 3: CONSENT — call ConsentManager.checkConsent (if active)
    // ------------------------------------------------------------------
    if (this.config.consentManager && ctx.consentPurpose && ctx.consentSubjectId) {
      const consentDecision = await this.config.consentManager.checkConsent(
        ctx.consentSubjectId,
        ctx.consentPurpose,
        actor.id,
      );
      if (!consentDecision.allowed) {
        return failResult(actionId, [
          {
            code: 'CONSENT_DENIED',
            message: `Consent denied for purpose ${ctx.consentPurpose}`,
          },
        ]);
      }
    }

    // ------------------------------------------------------------------
    // Step 4: PRECONDITIONS — resolve @param objects, evaluate CEL
    // ------------------------------------------------------------------
    // Resolve object params from SPI before CEL evaluation
    const resolvedVariables = await this.resolveParamObjects(
      actionTypeDef,
      params,
      schema,
      reqCtx,
    );

    // Add standard variables
    resolvedVariables['actor'] = { id: actor.id, roles: actor.roles, type: actor.type };
    resolvedVariables['now'] = now();
    resolvedVariables['params'] = params;

    for (const precondition of manifest.preconditions) {
      const result = await this.config.cel.evaluate(
        precondition.expr,
        resolvedVariables,
      );
      if (result.error) {
        return failResult(actionId, [
          {
            code: 'PRECONDITION_EVAL_ERROR',
            message: `Failed to evaluate precondition: ${result.error}`,
          },
        ]);
      }
      if (result.value !== true) {
        return failResult(actionId, [
          {
            code: 'PRECONDITION_FAILED',
            message: precondition.error,
          },
        ]);
      }
    }

    // ------------------------------------------------------------------
    // Step 5: EXECUTE — apply effects in manifest order, single txn
    // ------------------------------------------------------------------
    // Capture immutable context BEFORE first effect (spec Section 5.3)
    const immutableContext: Record<string, unknown> = { ...resolvedVariables };
    const affectedObjects: AffectedObject[] = [];
    const beforeStates: Map<string, Record<string, unknown>> = new Map();
    const afterStates: Map<string, Record<string, unknown>> = new Map();

    const txn = await this.config.storage.beginTransaction(reqCtx);

    try {
      for (const effect of manifest.effects) {
        await this.executeEffect(
          effect,
          immutableContext,
          txn,
          reqCtx,
          schema,
          affectedObjects,
          beforeStates,
          afterStates,
        );
      }
      await txn.commit();
    } catch (err) {
      await txn.rollback();
      return failResult(actionId, [
        {
          code: 'EFFECT_EXECUTION_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      ]);
    }

    // ------------------------------------------------------------------
    // Step 6: SIDE-EFFECTS — execute inline with retry
    // ------------------------------------------------------------------
    if (this.config.sideEffectHandler && manifest.sideEffects.length > 0) {
      for (const se of manifest.sideEffects) {
        const seResult = await this.config.sideEffectHandler.execute(
          se.name,
          se.type,
          se.config,
          immutableContext,
          se.retries,
        );

        if (!seResult.success) {
          const policy = manifest.rollback?.onSideEffectFailure ?? 'LOG_AND_CONTINUE';
          if (policy === 'ROLLBACK_ALL') {
            // CQ-24: Attempt compensating transaction to undo committed effects.
            // Reverses both object and link effects using beforeStates snapshots.
            try {
              const compensatingTxn = await this.config.storage.beginTransaction(reqCtx);
              try {
                for (const affected of affectedObjects) {
                  // Link entries use the `link:<type>:<id>` key prefix in beforeStates
                  const isLink = beforeStates.has(`link:${affected.type}:${affected.id}`);

                  if (isLink) {
                    if (affected.changeType === 'created') {
                      // Undo link creation by deleting the link
                      await compensatingTxn.deleteLink(affected.type, affected.id);
                    } else if (affected.changeType === 'deleted') {
                      // Undo link deletion by recreating from beforeStates snapshot
                      const before = beforeStates.get(`link:${affected.type}:${affected.id}`);
                      if (before && before['_fromId'] && before['_toId']) {
                        const { _fromId, _toId, _type, _id, _tenantId, _version, _createdAt, _updatedAt, _deletedAt, _fromType, _toType, ...props } = before;
                        await compensatingTxn.createLink(
                          affected.type,
                          _fromId as string,
                          _toId as string,
                          props,
                        );
                      }
                    }
                  } else {
                    const before = beforeStates.get(`${affected.type}:${affected.id}`);
                    if (affected.changeType === 'created') {
                      // Undo object create by soft-deleting
                      await compensatingTxn.deleteObject(affected.type, affected.id, 'soft');
                    } else if (affected.changeType === 'updated' && before) {
                      // Undo object update by restoring prior state.
                      // Strip system fields — storage manages these internally
                      // and they would cause column-mapping errors in Postgres.
                      const userProps = stripSystemFields(before);
                      await compensatingTxn.updateObject(affected.type, affected.id, userProps);
                    }
                    // 'deleted' object rollbacks are best-effort; recreating deleted objects
                    // requires the full prior state which may not always be available
                  }
                }
                await compensatingTxn.commit();
              } catch (innerErr) {
                console.error(`[ActionExecutor] Compensating transaction rollback for action ${actionId}:`, innerErr);
                await compensatingTxn.rollback();
              }
            } catch (outerErr) {
              console.error(`[ActionExecutor] Failed to begin compensating transaction for action ${actionId}:`, outerErr);
            }
            return failResult(actionId, [
              {
                code: 'SIDE_EFFECT_FAILURE',
                message: `Side-effect "${se.name}" failed: ${seResult.error ?? 'unknown error'}. Compensating transaction attempted.`,
              },
            ]);
          }
          // LOG_AND_CONTINUE / RETRY_INDEFINITELY: continue execution
        }
      }
    }

    // ------------------------------------------------------------------
    // Step 7: AUDIT — write AuditRecord with before/after, actor, traceId
    // Step 8: EMIT — publish CloudEvents for affected objects/links
    // ------------------------------------------------------------------
    // These run AFTER the transaction has committed. Failures here must not
    // cause the action to appear failed — the data is already persisted.
    try {
      if (this.config.auditWriter) {
        await this.config.auditWriter.write({
          id: `audit_${actionId}`,
          timestamp: now(),
          traceId: reqCtx.traceId ?? actionId,
          actor: {
            type: actor.type,
            id: actor.id,
            roles: actor.roles,
            ip: actor.ip,
          },
          operation: {
            type: 'action',
            actionType,
            actionId,
          },
          detail: {
            before: Object.fromEntries(beforeStates),
            after: Object.fromEntries(afterStates),
            result: 'success',
          },
        });
      }

      if (this.config.eventPublisher) {
        const cause = { actionType, actionId, actor: actor.id };
        for (const affected of affectedObjects) {
          const linkKey = `link:${affected.type}:${affected.id}`;
          const isLink = beforeStates.has(linkKey) || afterStates.has(linkKey);

          if (isLink) {
            // Use publishLinkChange for link effects with fromId/toId
            const linkState = (afterStates.get(linkKey) ?? beforeStates.get(linkKey)) as Record<string, unknown> | undefined;
            const fromId = (linkState?.['_fromId'] as string) ?? '';
            const toId = (linkState?.['_toId'] as string) ?? '';
            await this.config.eventPublisher.publishLinkChange(
              affected.changeType as 'created' | 'deleted',
              affected.type,
              affected.id,
              fromId,
              toId,
              cause,
              reqCtx,
            );
          } else {
            // Use publishObjectChange for object effects
            await this.config.eventPublisher.publishObjectChange(
              affected.changeType,
              affected.type,
              affected.id,
              beforeStates.get(`${affected.type}:${affected.id}`) as Record<string, unknown> | undefined,
              afterStates.get(`${affected.type}:${affected.id}`) as Record<string, unknown> | undefined,
              cause,
              reqCtx,
            );
          }
        }
      }
    } catch (postCommitErr) {
      console.error(`[ActionExecutor] Post-commit audit/event publishing failed for action ${actionId}:`, postCommitErr);
      // Do not return failure — the transaction already committed successfully.
    }

    return {
      success: true,
      actionId,
      errors: [],
      affectedObjects,
    };
  }

  // ─── Step 1: Param validation ───

  private validateParams(
    actionTypeDef: ActionType | undefined,
    params: Record<string, unknown>,
  ): ActionError[] {
    if (!actionTypeDef) {
      // If no schema definition, skip validation (structural-only mode)
      return [];
    }

    const errors: ActionError[] = [];
    for (const field of actionTypeDef.fields) {
      const isParam = field.directives.some((d) => d.kind === 'param');
      if (!isParam) continue;

      if (field.type.nonNull && (params[field.name] === undefined || params[field.name] === null)) {
        errors.push({
          code: 'MISSING_REQUIRED_PARAM',
          message: `Required parameter "${field.name}" is missing`,
          path: `params.${field.name}`,
        });
      }
    }
    return errors;
  }

  // ─── Step 4: Resolve param objects from SPI ───

  private async resolveParamObjects(
    actionTypeDef: ActionType | undefined,
    params: Record<string, unknown>,
    schema: ParsedSchema,
    reqCtx: RequestContext,
  ): Promise<Record<string, unknown>> {
    const resolved: Record<string, unknown> = {};

    if (!actionTypeDef) {
      // No schema; pass params through as-is
      Object.assign(resolved, params);
      return resolved;
    }

    for (const field of actionTypeDef.fields) {
      const isParam = field.directives.some((d) => d.kind === 'param');
      if (!isParam) continue;

      const paramValue = params[field.name];
      if (paramValue === undefined || paramValue === null) {
        resolved[field.name] = null;
        continue;
      }

      // Check if this param type is an object type in the schema
      const isObjectType = schema.objectTypes.some(
        (ot) => ot.name === field.type.name,
      );

      if (isObjectType && typeof paramValue === 'string') {
        // Resolve the object from storage by ID
        const obj = await this.config.storage.getObject(
          reqCtx,
          field.type.name,
          paramValue,
        );
        resolved[field.name] = obj ?? null;
      } else {
        // Scalar param — pass through
        resolved[field.name] = paramValue;
      }
    }

    return resolved;
  }

  // ─── Step 5: Effect execution ───

  private async executeEffect(
    effect: ActionEffect,
    context: Record<string, unknown>,
    txn: Transaction,
    reqCtx: RequestContext,
    schema: ParsedSchema,
    affectedObjects: AffectedObject[],
    beforeStates: Map<string, Record<string, unknown>>,
    afterStates: Map<string, Record<string, unknown>>,
  ): Promise<void> {
    switch (effect.type) {
      case 'updateObject':
        await this.executeUpdateObject(effect, context, txn, reqCtx, affectedObjects, beforeStates, afterStates);
        break;
      case 'createLink':
        await this.executeCreateLink(effect, context, txn, reqCtx, schema, affectedObjects, afterStates);
        break;
      case 'deleteLink':
        await this.executeDeleteLink(effect, context, txn, reqCtx, affectedObjects, beforeStates);
        break;
      case 'createObject':
        await this.executeCreateObject(effect, context, txn, affectedObjects, afterStates);
        break;
    }
  }

  private async executeUpdateObject(
    effect: UpdateObjectEffect,
    context: Record<string, unknown>,
    txn: Transaction,
    _reqCtx: RequestContext,
    affectedObjects: AffectedObject[],
    beforeStates: Map<string, Record<string, unknown>>,
    afterStates: Map<string, Record<string, unknown>>,
  ): Promise<void> {
    // Evaluate condition if present
    if (effect.condition) {
      const condResult = await this.config.cel.evaluate(effect.condition, context);
      if (condResult.value !== true) return;
    }

    // Resolve target to an object (supports dotted paths like "patient.currentBed")
    const target = this.resolveTarget(effect.target, context);
    if (!target) {
      throw new Error(`Target "${effect.target}" not found in context`);
    }

    // Resolve property values from CEL context
    const properties: Record<string, unknown> = {};
    for (const [key, expr] of Object.entries(effect.set)) {
      properties[key] = this.resolveExpression(expr, context);
    }

    // Capture before state
    const beforeKey = `${target._type}:${target._id}`;
    if (!beforeStates.has(beforeKey)) {
      beforeStates.set(beforeKey, { ...target });
    }

    const updated = await txn.updateObject(target._type, target._id, properties);

    afterStates.set(beforeKey, { ...updated });
    affectedObjects.push({
      type: target._type,
      id: target._id,
      changeType: 'updated',
    });
  }

  private async executeCreateLink(
    effect: CreateLinkEffect,
    context: Record<string, unknown>,
    txn: Transaction,
    _reqCtx: RequestContext,
    _schema: ParsedSchema,
    affectedObjects: AffectedObject[],
    afterStates: Map<string, Record<string, unknown>>,
  ): Promise<void> {
    // Evaluate condition if present
    if (effect.condition) {
      const condResult = await this.config.cel.evaluate(effect.condition, context);
      if (condResult.value !== true) return;
    }

    const fromObj = this.resolveTarget(effect.from, context);
    const toObj = this.resolveTarget(effect.to, context);
    if (!fromObj) throw new Error(`createLink "from" param "${effect.from}" not found in context`);
    if (!toObj) throw new Error(`createLink "to" param "${effect.to}" not found in context`);

    // Resolve link properties
    const properties: Record<string, unknown> = {};
    if (effect.properties) {
      for (const [key, expr] of Object.entries(effect.properties)) {
        properties[key] = this.resolveExpression(expr, context);
      }
    }

    const link = await txn.createLink(effect.linkType, fromObj._id, toObj._id, properties);

    const linkKey = `link:${effect.linkType}:${link._id}`;
    afterStates.set(linkKey, { ...link });
    affectedObjects.push({
      type: effect.linkType,
      id: link._id,
      changeType: 'created',
    });
  }

  private async executeDeleteLink(
    effect: DeleteLinkEffect,
    context: Record<string, unknown>,
    txn: Transaction,
    reqCtx: RequestContext,
    affectedObjects: AffectedObject[],
    beforeStates: Map<string, Record<string, unknown>>,
  ): Promise<void> {
    // Resolve filter to concrete link IDs (Section 5.3 deleteLink resolution)
    const matchingLinks = await this.resolveDeleteLinkFilter(
      effect,
      context,
      reqCtx,
    );

    const expect = effect.expect ?? 'ONE';

    if (expect === 'ONE') {
      if (matchingLinks.length !== 1) {
        throw new Error(
          `deleteLink ${effect.linkType}: expected exactly ONE matching link, found ${matchingLinks.length}`,
        );
      }
    }
    // expect === 'ALL': delete all matches (0 is valid for ALL)

    for (const link of matchingLinks) {
      const linkKey = `link:${effect.linkType}:${link._id}`;
      beforeStates.set(linkKey, { ...link });

      await txn.deleteLink(effect.linkType, link._id);

      affectedObjects.push({
        type: effect.linkType,
        id: link._id,
        changeType: 'deleted',
      });
    }
  }

  private async executeCreateObject(
    effect: CreateObjectEffect,
    context: Record<string, unknown>,
    txn: Transaction,
    affectedObjects: AffectedObject[],
    afterStates: Map<string, Record<string, unknown>>,
  ): Promise<void> {
    // Resolve property values
    const properties: Record<string, unknown> = {};
    for (const [key, expr] of Object.entries(effect.properties)) {
      properties[key] = this.resolveExpression(expr, context);
    }

    const created = await txn.createObject(effect.objectType, properties);

    const objKey = `${effect.objectType}:${created._id}`;
    afterStates.set(objKey, { ...created });
    affectedObjects.push({
      type: effect.objectType,
      id: created._id,
      changeType: 'created',
    });
  }

  // ─── deleteLink filter resolution (Section 5.3) ───

  private async resolveDeleteLinkFilter(
    effect: DeleteLinkEffect,
    context: Record<string, unknown>,
    reqCtx: RequestContext,
  ): Promise<OntologyLink[]> {
    // Resolve "from" and "to" filter references to object IDs
    let fromId: string | undefined;
    let toId: string | undefined;

    if (effect.filter.from) {
      const fromObj = this.resolveTarget(effect.filter.from, context);
      if (fromObj) {
        fromId = fromObj._id;
      }
    }

    if (effect.filter.to) {
      const toObj = this.resolveTarget(effect.filter.to, context);
      if (toObj) {
        toId = toObj._id;
      }
    }

    // Query links from SPI
    const results: OntologyLink[] = [];

    if (fromId) {
      const page = await this.config.storage.getLinks(
        reqCtx,
        fromId,
        effect.linkType,
        'outbound',
      );
      for (const link of page.items) {
        if (toId && link._toId !== toId) continue;
        if (effect.filter.active !== undefined && effect.filter.active && link._deletedAt) continue;
        results.push(link);
      }
    } else if (toId) {
      const page = await this.config.storage.getLinks(
        reqCtx,
        toId,
        effect.linkType,
        'inbound',
      );
      for (const link of page.items) {
        if (effect.filter.active !== undefined && effect.filter.active && link._deletedAt) continue;
        results.push(link);
      }
    }

    return results;
  }

  // ─── Expression resolution ───

  /**
   * Resolve a simple expression from the immutable action context.
   *
   * Resolution order:
   * 1. "'literal'" -> string literal (single-quoted within double-quoted YAML)
   * 2. "now" -> current timestamp
   * 3. Dot-path resolution: "params.field", "patient.status", etc.
   *    - If the root key exists in context, resolve the path
   *    - If an OntologyObject is reached, return its _id
   * 4. Fallback: if the root key is NOT in context, treat as literal string
   *    (e.g. "ACTIVE", "DISCHARGED", "OCCUPIED")
   */
  private resolveExpression(expr: string, context: Record<string, unknown>): unknown {
    // String literal: 'VALUE'
    if (expr.startsWith("'") && expr.endsWith("'")) {
      return expr.slice(1, -1);
    }

    // "now" -> timestamp
    if (expr === 'now') {
      return context['now'] ?? now();
    }

    // Dot-path resolution: "params.destination", "patient.currentWard", etc.
    const parts = expr.split('.');
    const rootKey = parts[0]!;

    // If the root key doesn't exist in context, treat the whole expression
    // as a literal string value (e.g. "ACTIVE", "DISCHARGED", "HOME")
    if (!(rootKey in context)) {
      return expr;
    }

    let current: unknown = context;

    for (const part of parts) {
      if (current === null || current === undefined) return null;
      if (typeof current === 'object') {
        current = (current as Record<string, unknown>)[part];
      } else {
        return null;
      }
    }

    // If the resolved value is an OntologyObject, return its _id
    // (used when setting properties like "patient" on a DischargeRecord)
    if (
      current !== null &&
      current !== undefined &&
      typeof current === 'object' &&
      '_id' in (current as Record<string, unknown>) &&
      '_type' in (current as Record<string, unknown>)
    ) {
      return (current as OntologyObject)._id;
    }

    return current ?? null;
  }

  /**
   * Resolve a dotted target path to an OntologyObject.
   *
   * Unlike resolveExpression (which returns _id for objects), this returns
   * the full object so the executor can read _type and _id from it.
   * Supports both flat keys ("patient") and dotted paths ("patient.currentBed").
   */
  private resolveTarget(target: string, context: Record<string, unknown>): OntologyObject | null {
    const parts = target.split('.');
    let current: unknown = context;

    for (const part of parts) {
      if (current === null || current === undefined) return null;
      if (typeof current === 'object') {
        current = (current as Record<string, unknown>)[part];
      } else {
        return null;
      }
    }

    if (
      current !== null &&
      current !== undefined &&
      typeof current === 'object' &&
      '_id' in (current as Record<string, unknown>) &&
      '_type' in (current as Record<string, unknown>)
    ) {
      return current as OntologyObject;
    }

    return null;
  }
}
