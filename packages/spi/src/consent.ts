/**
 * Consent management types (Section 7.3).
 */

import type { DateTime } from './scalars.js';

export enum DataPurpose {
  DIRECT_CARE = 'DIRECT_CARE',
  CARE_PLANNING = 'CARE_PLANNING',
  SERVICE_MANAGEMENT = 'SERVICE_MANAGEMENT',
  RESEARCH = 'RESEARCH',
  NATIONAL_REPORTING = 'NATIONAL_REPORTING',
}

export interface ConsentDecision {
  allowed: boolean;
  purpose: DataPurpose;
  basis: 'explicit_consent' | 'legitimate_interest' | 'legal_obligation' | 'vital_interest';
  restrictions?: FieldRestriction[];
}

/** A field-level restriction applied even when consent is granted. */
export interface FieldRestriction {
  objectType: string;
  field: string;
  reason: string;
}

export interface ConsentRecord {
  subjectId: string;
  purpose: DataPurpose;
  decision: 'GRANT' | 'DENY';
  grantedAt: string;
  evidence?: string;
}

export interface ConsentManager {
  checkConsent(subjectId: string, purpose: DataPurpose, requestor: string): Promise<ConsentDecision>;
  checkConsentBatch(subjectIds: string[], purpose: DataPurpose, requestor: string): Promise<Map<string, ConsentDecision>>;
  recordConsent(subjectId: string, purpose: DataPurpose, decision: 'GRANT' | 'DENY', evidence?: string): Promise<void>;
  revokeConsent(subjectId: string, purpose: DataPurpose, reason: string): Promise<RevocationResult>;
  getConsentRecord(subjectId: string): Promise<ConsentRecord[]>;
}

/** Result of a consent revocation (Section 7.3.4). */
export interface RevocationResult {
  subjectId: string;
  purpose: DataPurpose;
  revokedAt: DateTime;
  /** Count of in-flight requests that may still use prior consent. */
  activeSessions: number;
  /** Active subscriptions closed due to revocation. */
  subscriptionsTerminated: number;
}
