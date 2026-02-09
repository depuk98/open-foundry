/**
 * Action executor types (Section 5.3 & 5.4).
 *
 * Defines the interfaces for the action execution pipeline including
 * security, consent, CEL evaluation, audit, and result types.
 */

import type { AuditRecord, DataPurpose, StorageProvider, RequestContext } from '@openfoundry/spi';

// ---------------------------------------------------------------------------
// Actor identity
// ---------------------------------------------------------------------------

/** The actor executing an action. Passed through the pipeline for authz/audit. */
export interface ActionActor {
  id: string;
  type: 'user' | 'system' | 'connector';
  roles: string[];
  ip?: string;
}

// ---------------------------------------------------------------------------
// Execution context
// ---------------------------------------------------------------------------

/** Context for a single action execution. */
export interface ActionContext {
  /** SPI request context (tenant, traceId). */
  requestContext: RequestContext;
  /** Purpose for consent checks. If undefined, consent step is skipped. */
  consentPurpose?: DataPurpose;
  /** Subject ID for consent checks (e.g. patient ID). */
  consentSubjectId?: string;
}

// ---------------------------------------------------------------------------
// Security layer (injected dependency)
// ---------------------------------------------------------------------------

/**
 * Checks whether an actor has permission to execute an action.
 * Maps to spec Section 5.3 "Authorise" step.
 */
export interface SecurityLayer {
  checkPermission(
    actor: ActionActor,
    actionType: string,
    params: Record<string, unknown>,
    ctx: RequestContext,
  ): Promise<PermissionResult>;
}

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// CEL evaluator (injected dependency)
// ---------------------------------------------------------------------------

/**
 * Evaluates CEL expressions. In production backed by CelClient gRPC sidecar.
 * In tests backed by a mock that interprets expressions directly.
 */
export interface CelEvaluator {
  evaluate(
    expression: string,
    variables: Record<string, unknown>,
  ): Promise<CelEvalResult>;
}

export interface CelEvalResult {
  value?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Side-effect handler (injected dependency)
// ---------------------------------------------------------------------------

/** Executes side effects (webhooks, events) after effects commit. */
export interface SideEffectHandler {
  execute(
    name: string,
    type: string,
    config: Record<string, unknown>,
    context: Record<string, unknown>,
    retries?: number,
  ): Promise<SideEffectResult>;
}

export interface SideEffectResult {
  success: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Audit writer (injected dependency)
// ---------------------------------------------------------------------------

/** Writes audit records for completed actions. */
export interface AuditWriter {
  write(record: AuditRecord): Promise<void>;
}

// ---------------------------------------------------------------------------
// Event publisher (injected dependency)
// ---------------------------------------------------------------------------

/** Publishes CloudEvents for affected objects/links after action completion. */
export interface ActionEventPublisher {
  publishObjectChange(
    changeType: 'created' | 'updated' | 'deleted',
    objectType: string,
    objectId: string,
    before: Record<string, unknown> | undefined,
    after: Record<string, unknown> | undefined,
    cause: { actionType: string; actionId: string; actor: string },
    ctx: RequestContext,
  ): Promise<void>;

  publishLinkChange(
    changeType: 'created' | 'deleted',
    linkType: string,
    linkId: string,
    fromId: string,
    toId: string,
    cause: { actionType: string; actionId: string; actor: string },
    ctx: RequestContext,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Action result (Section 5.4)
// ---------------------------------------------------------------------------

export interface ActionResult {
  success: boolean;
  actionId: string;
  errors: ActionError[];
  affectedObjects: AffectedObject[];
  /** Non-blocking warnings (e.g. dry-run partial validation). */
  warnings?: string[];
}

export interface ActionError {
  code: string;
  message: string;
  /** Dot-path to relevant field, if applicable. */
  path?: string;
}

export type ChangeType = 'created' | 'updated' | 'deleted';

export interface AffectedObject {
  type: string;
  id: string;
  changeType: ChangeType;
}

// ---------------------------------------------------------------------------
// Executor configuration
// ---------------------------------------------------------------------------

/** Dependencies injected into the ActionExecutor. */
export interface ActionExecutorConfig {
  storage: StorageProvider;
  security: SecurityLayer;
  cel: CelEvaluator;
  consentManager?: import('@openfoundry/spi').ConsentManager;
  sideEffectHandler?: SideEffectHandler;
  auditWriter?: AuditWriter;
  eventPublisher?: ActionEventPublisher;
}
