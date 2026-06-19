---
title: Domain Pack Architecture
created: 2026-06-18
last_updated: 2026-06-18
type: concept
status: active
related_components:
  - odl-compiler
  - ontology-engine
  - actions
  - security-service
  - sync-engine
---

# Domain Pack Architecture

**Domain Packs** are composable, distributable bundles that specialize the Open Foundry platform for a particular operational domain. They are the mechanism by which domain-specific functionality — object types, actions, permissions, connectors, functions, quality rules, and reference applications — is delivered to a deployment. The platform itself is domain-neutral; domain packs make it an NHS acute platform, an AML platform, or a supply chain platform.

## What a Domain Pack Contains

```
nhs-acute/                       ← Domain pack root
├── schema/                      ← ODL schema files
│   ├── patient.odl              │  ObjectType definitions with directives
│   ├── ward.odl                 │  LinkType definitions
│   ├── theatre.odl              │  Interface implementations
│   ├── waiting-list.odl         │  Custom scalars
│   └── links.odl
├── actions/                     ← YAML action manifests
│   ├── discharge-patient.yaml   │  Preconditions (CEL)
│   ├── schedule-surgery.yaml    │  Effects (updateObject, createObject, deleteLink)
│   ├── transfer-ward.yaml       │  Side-effects (webhooks, events)
│   └── admit-patient.yaml       │  Rollback policies
├── connectors/                  ← Datasource and integration configs
│   ├── nhs-spine.yaml           │  JDBC connector configs
│   └── fhir-mapping.yaml        │  FHIR resource → ObjectType + ActionType mapping
├── functions/                   ← Sandboxed computation functions
│   ├── src/
│   │   ├── waitingListRisk.ts   │  TypeScript functions (WASM/V8 sandboxed)
│   │   └── bedPressureScore.ts  │  Read-only ontology access
│   └── package.json
├── permissions/                 ← OpenFGA model extensions
│   └── nhs-roles.fga            │  Domain-specific roles and relations
├── consent/                     ← Consent configuration
│   └── nhs-opt-out.yaml         │  National opt-out integration
├── quality/                     ← Data quality rules
│   └── rules.yaml               │  Cross-object and temporal quality checks
├── webhooks/                    ← Outbound webhook registrations
│   └── registrations.yaml
├── apps/                        ← Reference applications (optional)
│   ├── waiting-list-manager/
│   └── discharge-planner/
├── pack.yaml                    ← Pack metadata and dependencies
└── README.md
```

## Pack Manifest (pack.yaml)

The manifest declares the pack's identity, dependencies, capabilities, and configuration:

```yaml
name: nhs-acute
version: 1.0.0
description: "NHS acute healthcare domain pack for Open Foundry"
namespace: nhs.acute

dependencies:
  openfoundry.core: ">=1.0.0"

provides:
  objectTypes: 14
  linkTypes: 12
  actionTypes: 8
  functions: 5
  connectors: 3
  widgets: 6
  qualityRules: 12

fhir:
  profiles:
    Patient: "https://fhir.nhs.uk/StructureDefinition/NHSDigital-Patient"
    Encounter: "https://fhir.nhs.uk/StructureDefinition/NHSDigital-Encounter"
  mutations:
    Patient:
      create: AdmitPatient
      update: UpdatePatientDemographics
      delete: DeactivatePatient

terminology:
  - system: "http://snomed.info/sct"
    version: "2025-01"
```

## How Domain Packs Compose

Domain packs compose with the platform through well-defined integration points:

### 1. Schema Composition
ODL files in `schema/` are merged into the platform's schema registry under the pack's namespace (e.g., `nhs.acute`). Object types, link types, and action types are registered into the ontology. The `openfoundry.core` pack is always available and provides base interfaces (`Identifiable`, `Auditable`, `Locatable`, `Temporal`) and custom scalars.

### 2. Action Registration
YAML manifests in `actions/` define the behavior of ActionTypes declared in the pack's ODL schemas. Each manifest declares preconditions, effects, side-effects, and rollback policies. The Action Framework loads and registers these at runtime.

### 3. Permission Model Extension
`.fga` files in `permissions/` extend the auto-generated OpenFGA authorization model with domain-specific roles and relations (e.g., `clinician`, `nurse_in_charge`, `consultant`). The compiler merges auto-generated models with pack-provided extensions.

### 4. Connector Integration
YAML configs in `connectors/` define datasource bindings, FHIR resource mappings, and external system integrations. The Sync Engine loads these configurations at startup.

### 5. FHIR API Mapping
The `fhir.mutations` section maps FHIR write methods (POST/PUT/DELETE) to ActionTypes. This ensures FHIR mutations pass through the full action pipeline (authorize → consent → preconditions → audit). Unmapped FHIR methods return `405 Method Not Allowed`.

## Runtime Loading

Domain packs are loaded at runtime, not baked in at build time. The platform discovers packs from:
- `domain-packs/` in the monorepo (built-in packs)
- `DOMAIN_PACKS_EXTRA_DIRS` environment variable (external packs, colon-separated)

This enables organizations to maintain private domain packs outside the open-source monorepo while loading them into the same platform instance. Primary (monorepo) packs take precedence on name conflicts. Malformed packs are skipped with a warning — they do not abort loading of other packs.

## Domain Pack Versioning

Each pack declares its version in `pack.yaml`. Dependencies are declared with semver ranges (e.g., `openfoundry.core: ">=1.0.0"`). The platform resolves and validates dependencies at load time.

Action manifests within a pack have their own versioning:
- At any point, exactly one version of an ActionType is active per tenant.
- Deploying a new manifest version replaces the previous one (previous version archived for audit).
- In-flight actions complete with the version they started with.
- The ActionType's API signature is derived from ODL, not the YAML manifest — manifest-only changes do not change the API surface.

## Current Domain Packs

| Pack | Namespace | Object Types | Actions | Connectors | Purpose |
|------|-----------|-------------|---------|------------|---------|
| **Core** | `openfoundry.core` | 0 | 0 | 0 | Base interfaces, scalars. Always installed. |
| **NHS Acute** | `nhs.acute` | 14 | 8 | 3 | Patient flow through wards, beds, consultants |
| **AML** | `aml` | 8 | 6 | 1 | Anti-money laundering: transactions, alerts, cases |
| **Supply Chain** | `supply.chain` | 8 | 4 | 1 | Products, suppliers, shipments, purchase orders |

## Sources

- [Source: open-foundry-spec-v2.md Section 10 — Domain Packs]
- [Source: open-foundry-spec-v2.md Section 10.1 — Structure]
- [Source: open-foundry-spec-v2.md Section 10.2 — Pack Manifest]
- [Source: open-foundry-spec-v2.md Section 5.1.1 — Action Versioning]
- [Source: README.md — Domain Packs]
- [Source: README.md — External Domain Packs]
- [Source: AGENTS.md — Domain Pack Pattern]

## Related

- [[odl-schema-driven]] — How ODL schemas are the foundation of domain packs
- [[connector-pattern]] — How connectors are bundled into domain packs
- [[action-orientation]] — How action manifests in domain packs define governed mutations
- [[rebec-authorization]] — How permission model extensions in domain packs enrich ReBAC
