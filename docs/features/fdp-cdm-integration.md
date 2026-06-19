---
title: FDP/CDM Integration
created: 2026-06-18
last_updated: 2026-06-18
type: feature
status: in-progress
related_components:
  - api
  - ontology-engine
  - nhs-acute-pilot
related_decisions: []
---

# FDP/CDM Integration

The FDP/CDM compatibility layer converts OpenFoundry from "another open-source Foundry clone" into an **FDP-compatible runtime** by projecting the ODL operational ontology into a shape conforming to the NHS Federated Data Platform Canonical Data Model (CDM). This is the S1.0 deliverable from the [[fdp-plan]] and the most strategically important interoperability artifact.

## Summary

OpenFoundry does **not** embed the NHS FDP CDM. Instead, it ships a **declarative mapping profile** that projects the ODL operational ontology into a CDM-shaped, read-only view, preserving provenance end-to-end. The CDM target is the NHS England standard **DAPB4121** (currently draft-in-progress). This layer is the gateway for any trust to evaluate OpenFoundry as an FDP-integrable runtime.

### What It Claims

- **FDP-compatible runtime** — demonstrably mappable to the version-pinned CDM subset
- **Trust-controlled** — runs in the trust's infrastructure, not a centralised platform
- **Read-only ingestion** — no write-back to clinical systems of record
- **PET-compatible architecture** — data-flow registration, treatment-policy hooks, exportable IG evidence

### What It Does NOT Claim

- Not an NHS FDP instance
- Not a PET replacement or PET-certified service
- Not a production clinical decision support system

## Scope

### Starter Slice (S1.0 — Complete)

The first vertical slice covers the **NHS acute operational subset**: Patient, Ward, Bed, Admission, Discharge, Transfer, Staff (Consultant), Encounter.

**Deliverables completed:**

| Deliverable | Status | Location |
|-------------|--------|----------|
| Declarative mapping profile (machine-readable) | Done | `packages/api/src/cdm/profile.ts` |
| Provenance-preserving projection pipeline | Done | `packages/api/src/cdm/mappers.ts` — every record carries `_provenance` envelope |
| REST read API | Done | `GET /api/v1/cdm/metadata`, `/api/v1/cdm/{SourceType}`, `/api/v1/cdm/{SourceType}/{id}`, `/api/v1/cdm/Encounter?patient={id}` |
| GraphQL CDM view | Done | `cdmMetadata`, `cdmRecord`, `cdmRecords`, `cdmEncounters` queries |
| Human-readable mapping document | Done | [[cdm-mapping-profile]] |
| Compatibility matrix | Done | OpenFoundry `nhs-acute` 0.2.0 ↔ CDM `fdp-cdm-draft` (DAPB4121 draft-in-progress, quarterly revalidation) |
| Gap register (5 entries) | Done | Admission, Transfer, Staff, Patient.name, Terminology gaps documented with safe fallbacks |
| Tests | Done | `packages/api/src/__tests__/cdm.test.ts` — 19 tests (profile completeness, projection, enum remaps, provenance, gap register, GraphQL CDM resolvers) |

### Full Coverage (S2.2 — Planned)

Scoped to later stages: dataset export, structured-name decomposition (family/given), terminology validation against SNOMED CT/dm+d/ODS codes, first-class Transfer object, broader Staff coverage beyond Consultant.

## Implementation

### Architecture

The CDM projection sits in the `@openfoundry/api` package and operates within the same security boundary as FHIR and GraphQL:

```
Source System → Sync Engine → Ontology Engine (ODL)
                                     │
                                     ▼
                             CDM Mapper (profile.ts)
                                     │
                                     ▼
                    ┌────────────────┴────────────────┐
                    ▼                                 ▼
           REST /api/v1/cdm/*              GraphQL cdmRecord query
                    │                                 │
                    └──────────┬──────────────────────┘
                               ▼
                     Auth + Redaction + Consent Pipeline
```

The projection reuses the existing auth, field-level redaction, and consent enforcement pipeline — no new security surface.

### Resource Mappings

| ODL Type | CDM Resource | Key Lossy Fields |
|----------|-------------|------------------|
| Patient | Patient | `name` (single free-text vs structured family/given), `status` (TRANSFERRED→active), `triageCategory` (P1-P4 vs CDM-coded) |
| Ward | Location (kind=ward) | Clean mapping; none lossy |
| Bed | Location (kind=bed) | `status` (CLEANING and OUT_OF_SERVICE both→unavailable) |
| Consultant | Practitioner | `name` (single free-text), staff limited to consultant only |
| DischargeRecord | Discharge | `notes` (free-text), destination enum remap |
| AdmittedTo (link) | Encounter | `reason` (free-text, not terminology-coded), `status` derived from link soft-delete |

### Provenance Envelope

Every projected record carries a `_provenance` object enabling audit and lineage:

```json
{
  "sourceType": "Patient",
  "sourceId": "p-1",
  "sourceVersion": 3,
  "sourceUpdatedAt": "2026-05-25T10:00:00.000Z",
  "profileVersion": "0.1.0",
  "cdmVersion": "fdp-cdm-draft",
  "lossyFields": ["name", "status", "triageCategory"]
}
```

### Gap Register

| Area | Issue | Fallback |
|------|-------|----------|
| Admission | No separate `/Admission` route; surfaced as Encounter via `AdmittedTo` link | Treat Encounter as admission record |
| Transfer | No Transfer object type (TransferWard is an action, not a stored entity) | Reconstruct from Encounter history; first-class Transfer is S2.2 |
| Staff | Only Consultant modelled; no nurses, AHPs, admin staff | Extend with general Staff/Practitioner before full CDM coverage |
| Patient.name | Single free-text string vs CDM structured family/given | Export raw string; marked lossy in provenance |
| Terminology | Coded fields are free strings/local enums, not SNOMED/dm+d/ODS validated | Terminology validation at connector layer (S1.2) and full CDM (S2.2) |

### API Surface

| Endpoint | Description | Auth |
|----------|-------------|------|
| `GET /api/v1/cdm/metadata` | Profile, compatibility matrix, gap register | Public |
| `GET /api/v1/cdm/{SourceType}` | List projection (Patient, Ward, Bed, Consultant, DischargeRecord) | Required |
| `GET /api/v1/cdm/{SourceType}/{id}` | Single record projection | Required |
| `GET /api/v1/cdm/Encounter?patient={id}` | Admissions for a patient (via AdmittedTo link) | Required (consent-gated) |

Patient and Encounter projections are consent-gated (subject = patient). Ward, Bed, Consultant, and DischargeRecord are authorization + redaction gated.

## Status & Roadmap

### Completed (S1.0)
- [x] Declarative mapping profile (ODL directives + machine-readable profile.ts)
- [x] Provenance-preserving projection with `_provenance` per record
- [x] REST read API at `/api/v1/cdm/*` (metadata, list, get, Encounter-by-patient)
- [x] GraphQL CDM view (`cdmMetadata`/`cdmRecord`/`cdmRecords`/`cdmEncounters`)
- [x] Human-readable [[cdm-mapping-profile]] with compatibility matrix
- [x] Gap register (5 documented gaps with fallbacks)
- [x] 19 tests covering profile, projection, enum remaps, provenance, gaps, GraphQL resolvers

### Remaining (S1.0 extensions)
- [ ] Dataset export (bulk CDM-shaped data dump)
- [ ] Structured-name decomposition (family/given from free-text)
- [ ] Terminology validation against SNOMED CT, dm+d, ODS
- [ ] First-class Transfer object (currently action-only)
- [ ] Broader Staff coverage beyond Consultant

### Full Coverage (S2.2)
- [ ] Full FHIR R4 UK Core as ODL
- [ ] Complete CDM resource set (all FDP-published resources)
- [ ] NHS Spine connector integration (PDS, SDS, e-RS)
- [ ] EPR vendor-specific mappings (Cerner, Epic, System C, TPP, EMIS)
- [ ] Terminology service integration

### Conformance Method
- Version-pinned public CDM schema/OpenAPI/glossary where available (DAPB4121)
- Synthetic patient/ward/bed/admission records from `@openfoundry/seed-nhs-acute`
- Negative fixtures: lossy mappings, invalid terminology, missing provenance, malformed identifiers
- Quarterly re-validation against CDM revisions

## Sources

- [Source: docs/fdp-plan.md — S1.0 FDP/CDM compatibility profile, full Stage 1/Stage 2 plan]
- [Source: docs/cdm-mapping-profile.md — resource mappings, gap register, provenance, API]
- [Source: packages/api/src/cdm/profile.ts — machine-readable mapping profile]
- [Source: packages/api/src/cdm/mappers.ts — provenance-preserving projection]
- [Source: packages/api/src/__tests__/cdm.test.ts — 19 tests]
- [Source: README.md — FDP/CDM projection section]
