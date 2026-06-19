---
title: AML Domain Pack
created: 2026-06-18
last_updated: 2026-06-18
type: feature
status: active
related_components:
  - ontology-engine
  - actions
  - security
  - sync-engine
  - api
related_decisions: []
---

# AML Domain Pack

The Anti-Money Laundering and financial compliance domain pack (`aml`, v0.1.0) provides transaction monitoring, alert triage, case investigation, and Suspicious Activity Report (SAR) filing capabilities. It models the full compliance workflow from flagged transactions through to regulatory submissions.

## Scope

### Object Types (6)

| Type | Description |
|------|-------------|
| **Customer** | KYC-checked entity. Fields: `id`, `externalId` (unique, immutable), `name` (sensitive, searchable), `type` (CustomerType), `riskLevel` (RiskLevel), `kycStatus`, `kycExpiryDate`, `country`, `dateOfBirth` (sensitive), `taxId` (sensitive, unique). |
| **Account** | Financial account belonging to a customer. Fields: `id`, `accountNumber` (unique, immutable, sensitive), `type` (AccountType), `status` (AccountStatus), `currency`, `customer` (FK), `openDate`, `lastActivityDate`. |
| **Transaction** | Financial transaction between accounts. Fields: `id`, `referenceId` (unique, immutable), `type` (TransactionType), `status`, `amount` (>0 constraint), `currency`, `sourceAccount`, `destinationAccount`, `transactionDate`, `description`, `country`. |
| **Alert** | System-generated or manual alert for suspicious activity. Fields: `id`, `alertNumber` (unique, immutable), `severity` (AlertSeverity), `status` (AlertStatus), `ruleName`, `score` (>=0), `narrative`, `transaction` (FK), `customer` (FK), `assignedTo`, `createdDate`. |
| **Case** | Investigation case grouping related alerts. Fields: `id`, `caseNumber` (unique, immutable), `status` (CaseStatus), `priority` (AlertSeverity), `assignedAnalyst`, `summary`, `openDate`, `closeDate`, `alertCount` (computed from AlertCase links). |
| **SuspiciousActivityReport** | Regulatory filing to FinCEN/equivalent. Fields: `id`, `sarNumber` (unique, immutable), `status` (SarStatus), `filingDate`, `narrative`, `amount` (>0 constraint), `reportingEntity`, `caseRef` (FK). |

### Link Types (7)

| Link | From | To | Cardinality | Notes |
|------|------|----|-------------|-------|
| `AlertCase` | Alert | Case | MANY_TO_ONE | Active link managed by `AssignAlertToCase`. Fields: `assignedDate`, `assignedBy`. |
| `CustomerAccount` | Customer | Account | ONE_TO_MANY | Implicit reference (FK on Account.customer) |
| `AccountTransaction` | Account | Transaction | ONE_TO_MANY | Implicit reference (FK on Transaction.sourceAccount) |
| `CounterpartyTransaction` | Account | Transaction | ONE_TO_MANY | Implicit reference (FK on Transaction.destinationAccount) |
| `TransactionAlert` | Transaction | Alert | ONE_TO_MANY | Implicit reference (FK on Alert.transaction) |
| `AlertForCustomer` | Customer | Alert | ONE_TO_MANY | Implicit reference (FK on Alert.customer) |
| `CaseReport` | Case | SuspiciousActivityReport | ONE_TO_MANY | Implicit reference (FK on SAR.caseRef) |

### Actions (6)

| Action | Description | Key Params |
|--------|-------------|------------|
| `FlagTransaction` | Flag a suspicious transaction, creating an Alert | transaction, customer, alertNumber, severity, ruleName, score?, narrative? |
| `OpenCase` | Open a new investigation case | caseNumber, priority, assignedAnalyst, summary? |
| `AssignAlertToCase` | Link an alert to an existing investigation case (creates AlertCase link) | alert, investigationCase |
| `FreezeAccount` | Freeze an account with documented reason | account, reason |
| `FileReport` | File a Suspicious Activity Report for FinCEN filing | investigationCase, sarNumber, narrative, amount, reportingEntity |
| `SubmitReport` | Submit a filed SAR to the regulatory authority | sar, investigationCase |

## Implementation

The pack is composed of:
- **8 ODL schemas**: `enums.odl`, `customer.odl`, `account.odl`, `transaction.odl`, `alert.odl`, `case.odl`, `suspicious-activity-report.odl`, `links.odl`, `actions.odl`
- **6 action manifests**: YAML files with CEL preconditions/effects for each compliance action
- **Permissions**: `aml-roles.fga` — OpenFGA authorization model for compliance analysts, investigators, and supervisors
- **Tests**: `src/__tests__/aml-pack.test.ts`

The workflow follows a standard compliance pipeline: transactions are monitored → suspicious ones are flagged as Alerts → Alerts are assigned to investigation Cases → Cases result in SAR filings → SARs are submitted to authorities.

Six of seven link types are **implicit reference links** — foreign keys stored directly on child objects, with link type declarations enabling graph traversal via the link-sync pipeline. Only `AlertCase` is an actively managed link created by the `AssignAlertToCase` action.

## Connectors

### TMS_Transactions (JDBC)

- **Datasource**: `TMS_Transactions` — connects to a Transaction Monitoring System (Actimize, Oracle FCCM, etc.)
- **Connector type**: `jdbc`
- **Sync mode**: `OVERLAY` with TTL cache (PT5M)
- **Writeback**: disabled (`writeback: false`)
- **Mapping**: `transaction_log` table → `Transaction` object type. Transforms `txn_id` to prefixed `txn-{id}`, maps reference numbers, amounts, currencies, account references, timestamps, and jurisdiction codes
- **Future**: CDC mode deferred post-MVP

## Status & Roadmap

- **Current**: Active. Full schema, actions, and JDBC connector implemented (v0.1.0).
- **v0.1.0**: Initial version with 6 object types, 7 link types, 6 actions, 1 connector
- **Pending**: CDC sync mode for real-time transaction monitoring; additional connectors for sanctions screening, PEP databases, and adverse media

## Sources

- [Source: domain-packs/aml/pack.yaml]
- [Source: domain-packs/aml/schema/ — all ODL schemas]
- [Source: domain-packs/aml/actions/ — action manifests]
- [Source: domain-packs/aml/connectors/tms-jdbc.yaml]
- [Source: domain-packs/aml/permissions/aml-roles.fga]
