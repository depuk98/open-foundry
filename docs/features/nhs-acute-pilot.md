---
title: NHS Acute Pilot
created: 2026-06-18
last_updated: 2026-06-20
type: feature
status: active
related_components:
  - ontology-engine
  - action-executor
  - security-service
  - sync-engine
  - api-gateway
  - fdp-cdm-integration
related_decisions:
  - adr-013-palantir-domain-pack-refactor
related_features:
  - domain-pack-palantir-refactor
---

# NHS Acute Pilot

The NHS acute healthcare domain pack (`nhs.acute`, v0.2.0) is the primary vertical slice for OpenFoundry, targeting patient flow through wards, beds, and consultants at an acute trust. It positions OpenFoundry as an **FDP-compatible, trust-controlled ontology runtime** that can ingest read-only source data, map a bounded operational ontology to a version-pinned FDP/CDM subset, and evidence flows under ReBAC, consent, and audit. This is the pilot-phase domain pack driving the FDP integration plan [[fdp-cdm-integration]].

## Scope

### Object Types (5)

| Type | Description |
|------|-------------|
| **Patient** | Core entity. Fields: `id`, `nhsNumber` (unique), `name` (sensitive), `dateOfBirth` (sensitive), `status` (PatientStatus enum), `triageCategory`, `presentingComplaint`. Linked to Ward via `AdmittedTo`, Bed via `OccupiesBed`, Consultant via `UnderCareOf`. |
| **Ward** | Hospital ward. Fields: `id`, `name`, `specialty`, `capacity`, `currentOccupancy` (computed), inbound links to `Patient` and `Bed`. |
| **Bed** | Physical bed. Fields: `id`, `number`, `type` (BedType), `status` (BedStatus: AVAILABLE, OCCUPIED, CLEANING, OUT_OF_SERVICE). Linked to `Ward` via `BedInWard`, to `Patient` via `OccupiesBed`. |
| **Consultant** | Responsible clinician. Fields: `id`, `gmcNumber` (unique), `name`, `specialty`. Linked to `Patient` via `UnderCareOf`. |
| **DischargeRecord** | Discharge event. Fields: `id`, `patient` (FK), `ward` (FK), `destination` (DischargeDestination enum), `dischargeDate`, `notes`. Linked to Patient/Ward via implicit references. |

### Link Types (6)

| Link | From | To | Cardinality | Notes |
|------|------|----|-------------|-------|
| `AdmittedTo` | Patient | Ward | MANY_TO_ONE | Tracks admission: `admissionDate`, `expectedDischarge`, `reason` |
| `OccupiesBed` | Patient | Bed | ONE_TO_ONE | Current bed assignment: `assignedAt` |
| `UnderCareOf` | Patient | Consultant | MANY_TO_ONE | Attending consultant: `assignedDate`, `role` (CareRole) |
| `BedInWard` | Bed | Ward | MANY_TO_ONE | Bed belongs to ward |
| `DischargedPatient` | DischargeRecord | Patient | MANY_TO_ONE | Which patient was discharged |
| `DischargedFromWard` | DischargeRecord | Ward | MANY_TO_ONE | Which ward the patient was discharged from |

### Actions (5)

| Action | Description | Key Params |
|--------|-------------|------------|
| `AdmitPatient` | Admit a patient to a ward, optionally to a specific bed and consultant | patient, ward, bed?, consultant, reason |
| `DischargePatient` | Discharge a patient with destination and notes | patient, destination, notes? |
| `TransferWard` | Transfer a patient to another ward, optionally to a specific bed | patient, toWard, toBed?, reason |
| `CleanBed` | Return a bed from CLEANING to AVAILABLE (porter/housekeeping action) | bed |
| `RegisterPatient` | Governed patient registration (ED arrival). Creates Patient in DISCHARGED state with default DIRECT_CARE consent | name, dateOfBirth, nhsNumber?, triageCategory?, presentingComplaint?, consent? |

## Implementation

The pack is composed of:
- **7 ODL schemas**: `enums.odl`, `patient.odl`, `ward.odl`, `bed.odl`, `consultant.odl`, `discharge-record.odl`, `links.odl`, `actions.odl`
- **5 action manifests**: YAML files defining preconditions, CEL effects, and side-effects for each action
- **Permissions**: `nhs-roles.fga` — OpenFGA authorization model with ward-scoped visibility and role-based access
- **Tests**: `src/__tests__/nhs-acute-pack.test.ts`

All actions go through the mandatory pipeline: validate → authorize → consent → preconditions → execute → side-effects → audit. Object creation/mutation happens through governed actions, not generic CRUD.

The `CleanBed` action completes the bed lifecycle; discharge and transfer leave the vacated bed in CLEANING state, requiring a separate cleaning action to make it AVAILABLE again. `RegisterPatient` is role-gated by CEL (receptionist/clinician/nurse_in_charge) since no pre-existing object exists for ReBAC authorization.

## Connectors

### PAS_Patients (JDBC)

- **Datasource**: `PAS_Patients` — connects to a Patient Administration System database
- **Connector type**: `jdbc`
- **Sync mode**: `OVERLAY` with TTL cache (PT5M)
- **Writeback**: disabled (`writeback: false`), enforcing the Stage 1 read-only boundary
- **Mapping**: patients table → `Patient` object type. Transforms `patient_id` to prefixed `patient-{id}`, concats name fields, parses dates, derives `status` from `discharge_date` presence
- **Future**: CDC mode deferred post-pilot (commented out in config)

This is the only Stage 1 connector for NHS Acute. The FDP plan specifies three additional connectors for Stage 1.2 (FHIR R4, HL7v2 MLLP, HTTP webhook listener), all read-only.

## Status & Roadmap

- **Current**: Active (pilot phase). Full schema, actions, and JDBC connector implemented and tested. The Nightingale reference app ([[fdp-plan]] S1.4) runs in Pilot Mode B against the governed stack.
- **v0.2.0**: Current version with 5 object types, 6 link types, 5 actions, 1 connector
- **FDP Plan S1.0**: CDM mapping profile complete (Patient → CDM Patient, Ward/Bed → CDM Location, Consultant → CDM Practitioner, DischargeRecord → CDM Discharge, AdmittedTo → CDM Encounter). Provenance-preserving projection at `/api/v1/cdm/*`. Gap register published in [[cdm-mapping-profile]].
- **FDP Plan S1.2**: Harden JDBC+CDC connector for real PAS; add FHIR R4 read-only, HL7v2 MLLP, and webhook connector
- **FDP Plan S2.2**: Full NHS Domain Pack v2 with FHIR R4 UK Core as ODL, NHS Spine connectors, EPR vendor mappings, full CDM coverage

### Pilot Mode Matrix (from FDP Plan)

| Mode | Inputs | Actions | Users | Approval |
|------|--------|---------|-------|----------|
| Mode A | Real PAS data | Disabled | Analysts, IG reviewers | IG lead |
| Mode B | Synthetic mirrored data | Enabled (admit/discharge/transfer) | Named clinicians | CSO + IG lead |
| Mode C | De-identified/pseudonymised real data | Enabled (if approved) | Named clinicians | Caldicott Guardian + IG lead + CSO |

## Sources

- [Source: domain-packs/nhs-acute/pack.yaml]
- [Source: domain-packs/nhs-acute/schema/ — all ODL schemas]
- [Source: domain-packs/nhs-acute/actions/ — action manifests]
- [Source: domain-packs/nhs-acute/connectors/pas-jdbc.yaml]
- [Source: domain-packs/nhs-acute/permissions/nhs-roles.fga]
- [Source: docs/fdp-plan.md — S1.0 CDM mapping, S1.4 Bed Management, pilot mode matrix]
- [Source: docs/cdm-mapping-profile.md — CDM gap register and resource mappings]
- [Source: README.md — NHS Acute Pilot section]
