---
title: palantir-refactor-impact
created: 2026-06-20
type: synthesis
related_components:
  - odl
  - sync-engine
  - ner-extraction
  - api-gateway
related_features:
  - domain-pack-palantir-refactor
  - osint-domain-pack
  - nhs-acute-pilot
related_decisions:
  - adr-013-palantir-domain-pack-refactor
---

# Palantir Refactor — Cross-Cutting Impact Analysis

How the 4-principle domain pack restructure affects every layer of Open Foundry.

## Schema Layer

**Before**: 5 flat packs with `schema/` directories. Person/Org/Loc/Eq defined in OSINT with intel attributes. NHS Patient had duplicate `name`/`dateOfBirth`.

**After**: 27 object types, 58 link types, 44 enums across 5 packs. Core entities extracted. All packs organized into 4-layer directories. Canonical Person has ~16 fields shared across all domains.

**Impact**: Schema checksums changed → `docker compose down -v` required. Migration plan auto-approved by schema registry (version 1→2).

## ODL Compilation

ODL parser and GraphQL codegen are schema-driven — they process `ParsedSchema` objects, not file paths. The directory restructure is transparent to both.

**Impact**: None. ODL compilation unchanged. GraphQL codegen auto-generates 31 object types + 63 link types correctly.

**Issue encountered**: Core link types with empty bodies (`type Foo @linkType(...)`) caused GraphQL SDL parse error (no properties in type body). Fixed by adding `{ id: ID! @primary }` to all link types.

## Entity Extraction Pipeline

**Before**: Single `createEntity()` call per entity. All fields (core + intel) passed in one create.

**After**: Dual creates — core entity + domain extension. Returns extension ID for correct link target.

**Impact**: +1 DB write per entity. Negligible overhead. Dedup queries now target core `person._normalized_name` instead of extension table.

**Issue encountered**: Test expected 1 `objectManager.create()` call → now 2 calls for dual create. Fixed by updating assertion.

## NHS Action Layer

**Before**: `register-patient.yaml` created Patient with `name` and `dateOfBirth` inline.

**After**: Dual creates Person + Patient. Cross-effect reference `"person._id"` links Patient to core Person.

**Impact**: Field permissions updated — removed stale `name`/`dateOfBirth`, kept only scalar fields. Consent and side effects unchanged (still reference `"patient"`).

## Pack Loading

**Before**: `pack.yaml` listed files under `schema/`.

**After**: All 5 `pack.yaml` files updated with new paths under `objects/`, `observations/`, `workflows/`.

**Impact**: Pack loader reads `pack.yaml` schema list — doesn't do recursive ODL discovery. New paths are just string changes in YAML. No code change needed.

## Docker Deployment

**Impact**: Container rebuild required to include new ODL files in the image. Build cache can cause stale files if `--no-cache` is not used. Three build iterations needed during implementation due to type reference bugs in sed replacements and ODL syntax errors.

## Open Questions Not Resolved

1. **NHS `register-patient` consent subject**: Currently references `"patient"` (the Patient object). Should it reference core Person instead? Deferred — consent is on the Patient record, which is correct for DIRECT_CARE.

2. **`_normalizedName` secondary lookup**: On cold DB start, `queryByName` finds core Person via `_normalizedName` but the cache needs the IntelSubject ID. Currently handled by in-memory cache only. Cross-restart dedup needs a secondary query `SELECT _id FROM intel_subject WHERE person_id = $1`. Deferred to future optimization.

3. **OSINT `links.odl` location**: Currently in `schema/` alongside `enums.odl` and `actions.odl`. Moving to pack root or `links/` directory would be more consistent with layered architecture. Minor — no functional impact.

## Sources

- [[domain-pack-palantir-refactor-spec]]
- [[domain-pack-palantir-refactor-plan]]
- [[adr-013-palantir-domain-pack-refactor]]
