/**
 * Audit record types (Section 7.2).
 */

import type { DateTime } from './scalars.js';

export interface AuditRecord {
  id: string;
  timestamp: DateTime;
  traceId: string;
  actor: AuditActor;
  operation: AuditOperation;
  detail: AuditDetail;
}

export interface AuditActor {
  type: 'user' | 'system' | 'connector';
  id: string;
  roles: string[];
  ip?: string;
}

export interface AuditOperation {
  type: 'read' | 'create' | 'update' | 'delete' | 'action' | 'query' | 'link' | 'unlink';
  objectType?: string;
  objectId?: string;
  actionType?: string;
  actionId?: string;
}

export interface AuditDetail {
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  query?: string;
  result?: 'success' | 'denied' | 'error';
  denialReason?: string;
  consentDecision?: 'granted' | 'denied' | 'not_required';
}
