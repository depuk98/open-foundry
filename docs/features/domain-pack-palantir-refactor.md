---
title: domain-pack-palantir-refactor
created: 2026-06-20
last_updated: 2026-06-20
type: feature
status: complete
related_components:
  - odl
  - sync-engine
  - ner-extraction
  - api-gateway
related_decisions:
  - adr-013-palantir-domain-pack-refactor
related_features:
  - osint-domain-pack
  - nhs-acute-pilot
---

# Domain Pack Palantir Refactor

Restructured all 5 Open Foundry domain packs to follow Palantir Foundry's 4 ontology design principles. Extracted canonical entity types into a shared `core/objects/` pack. Renamed OSINT types with domain prefixes. Linked NHS Patient and Consultant to core Person via dual creates.

## Scope

- Extract canonical Person, Organization, Location, Equipment from OSINT pack into `core/objects/`
- Rename OSINT types: Person→IntelSubject, Organization→IntelOrganization, Location→IntelLocation, Equipment→IntelEquipment, Event→IntelEvent
- Remove `name`/`dateOfBirth` from NHS Patient and Consultant — replace with link to core Person
- Dual-create pattern: `createEntity()` creates core entity + domain extension, returns extension ID
- Reorganize all 5 packs into `objects/`, `observations/`, `workflows/`, `actions/` subdirectories
- Create 6 shared link types in `core/links.odl` connecting domain extensions to canonical entities
- Update all 30+ OSINT link type `from`/`to` references

## Implementation

**23 tasks across 4 phases.** 12 new files, 18 modified, 12 deleted.

### Key files created
- `core/objects/person.odl` — Canonical Person (fullName, aliases, dateOfBirth, nationality, contact info, location)
- `core/objects/organization.odl` — Canonical Organization (name, aliases, acronym, country, location)
- `core/objects/location.odl` — Canonical Location (name, aliases, country, coordinates, region)
- `core/objects/equipment.odl` — Canonical Equipment (designation, manufacturer, originCountry, specifications)
- `core/links.odl` — 6 shared link types (ProfileForPerson, PatientProfileForPerson, etc.)
- `osint/objects/intel-subject.odl` — Intelligence-tracked person (threatLevel, watchlistStatus)
- `osint/objects/intel-organization.odl` — Intelligence-tracked organization (unitDesignation, isDesignated)
- `osint/objects/intel-location.odl` — Intelligence-tracked location (strategicValue, isMilitaryBase)
- `osint/objects/intel-equipment.odl` — Intelligence-tracked equipment (category, capabilities, losses)
- `osint/objects/intel-event.odl` — Intelligence-tracked event (fatalities, attribution, participants)

### Key code changes
- `entity-extraction-service.ts:createEntity()` — Dual creates: core entity + domain extension, returns extension ID
- `entity-dedup.ts:tableNameFor()` — Updated Event→intel_event mapping
- `register-patient.yaml` — Dual creates: Person + Patient, references `person._id`
- `field-permissions.yaml` — Removed stale `name`/`dateOfBirth` from Patient, added scalar fields only
- All pack `pack.yaml` files — Updated with new file paths

## Verification

| Check | Result |
|-------|--------|
| `pnpm --filter @openfoundry/sync test` | 302/302 passing |
| `pnpm --filter @openfoundry/api build` | Clean compilation |
| Docker compose | 13 services healthy, clean start with `down -v` |
| GraphQL schema | 31 object types, 63 link types — all 11 new types visible |
| NER pipeline | 43+ successful extractions with dual-create pattern |
| Field permission warnings | 0 (previously 8, fixed) |

## Status & Roadmap

- **Complete**: Core extraction, OSINT renames, NHS linking, directory restructuring, dual creates, pack manifests
- **Future**: Relation extraction, source credibility auto-scoring, `Verifiable`/`Credible`/`Monitored` interfaces, analyst review loop

## Sources

- [[domain-pack-palantir-refactor-spec]] — Full specification
- [[domain-pack-palantir-refactor-plan]] — Implementation plan
- [[adr-013-palantir-domain-pack-refactor]] — Architecture decision record
- [[palantir-ontology-design]] — 4-layer architecture concept
- [[domain-extension-pattern]] — Dual-create + linked extension pattern
- [[osint-platform-roadmap]] — Future proposals for OSINT platform
