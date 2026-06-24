---
title: adr-013-palantir-domain-pack-refactor
created: 2026-06-20
type: decision
status: accepted
---

# ADR-013: Apply Palantir's 4 ontology design principles to domain pack architecture

## Context

Open Foundry had 5 domain packs (core, osint, nhs-acute, aml, supply-chain) with flat `schema/` directories. Entity types like `Person`, `Organization`, `Location`, `Equipment` were defined in the OSINT pack with intelligence-specific attributes (threatLevel, watchlistStatus, isPersonOfInterest). The NHS pack defined `Patient` with duplicate `name` and `dateOfBirth` fields. Three domain packs had 3 different copies of the same Person fields — violating DRY.

Adding a new domain pack (e.g., financial crime) would require either reusing OSINT's Person with irrelevant intel attributes, or creating yet another duplicate. The architecture didn't support cross-domain entity sharing.

## Decision

Restructure all domain packs following Palantir Foundry's 4 ontology design principles:

1. **Domain-Driven Design**: Model the real world, not the source data. A tweet is a source observation (IntelReport) that references entities (Person, Organization) — it's not the entity itself.

2. **Don't Repeat Yourself**: Extract canonical Person, Organization, Location, Equipment into a shared `core/objects/` pack. All domain packs link to these canonical types via extension types (IntelSubject, Patient, Customer).

3. **Open for Extension, Closed for Modification**: Core entity types have ~6-16 canonical fields and are locked. Domain-specific attributes live in linked extension types. Adding financial-crime support means creating `CustomerProfile` linking to core Person — no core modification needed.

4. **Composition over Deep Hierarchies**: Shared capabilities (Identifiable, Auditable, Locatable) are interfaces. Future interfaces (Verifiable, Credible, Monitored) can compose across types without modifying ODL.

All 5 domain packs reorganized into 4-layer directories:
- `objects/` — Real-world entities (Person, IntelSubject, Patient, Equipment)
- `observations/` — Source artifacts (IntelReport, SourceProfile, DischargeRecord)
- `workflows/` — Analyst-created products (Assessment, Indicator, Narrative, Case)
- `actions/` — Kinetic operations (action manifests)

## Alternatives Considered

### Keep flat schema per pack, use imports
- **Pros**: No directory restructure needed
- **Cons**: Imports don't solve the DRY problem — each pack would still define its own entity types. No enforcement of layer separation.

### Inline entity attributes (no core extraction)
- **Pros**: Simpler createEntity() — single write, no dual records
- **Cons**: Adding a second domain that needs Person would require duplication (violates DRY). Cross-domain queries impossible.

### Core extraction deferred to future phase
- **Pros**: Lower immediate risk
- **Cons**: NHS Patient would keep duplicate `name`/`dateOfBirth` fields. The architecture would need a second refactor later, doubling migration cost. Palantir Rule of Three: refactor at duplication #2, not #3.

## Consequences

**Easier:**
- Adding a new domain pack (financial-crime, pandemic, law-enforcement) — just create extension types linking to core entities
- Cross-domain queries: `IntelSubject.person.patient.nhsNumber` traverses from OSINT through core to NHS in one query
- Adding shared capabilities (Verifiable interface) — affects all types implementing it

**Harder:**
- `createEntity()` now performs dual creates (core entity + domain extension), adding 1 DB write per entity
- Schema changes require `docker compose down -v` (checksum-based migration system detects ODL changes)
- NHS `register-patient.yaml` must dual-create Person + Patient, requiring understanding of action executor's cross-effect context injection

**Migration path**: Implemented in one phase (immediate dual creates for both OSINT and NHS). No gradual rollout. Clean DB volume wipe required.

## Sources

- [[domain-pack-palantir-refactor-spec]] — Full specification
- [[domain-pack-palantir-refactor-plan]] — Implementation plan (23 tasks, 4 phases)
- [[palantir-ontology-design]] — Concept page for 4-layer architecture
- [[domain-extension-pattern]] — Concept page for dual-create + linked extension pattern
- [[observations-vs-objects]] — Concept page for the observation/object semantic distinction
- Palantir Foundry Ontology Best Practices: Model the real world, not the source data
- STIX 2.1 specification: Domain Objects (SDO) vs Relationship Objects (SRO) separation
