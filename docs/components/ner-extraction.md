---
title: NER Extraction
created: 2026-06-18
last_updated: 2026-06-18
type: component
package: "@openfoundry/sync"
status: active
related_components:
  - sync-engine
  - api-gateway
  - ontology-engine
related_features:
  - osint-domain-pack
  - ner-entity-extraction-plan
related_decisions:
  - adr-011-ner-compromise-over-wink
---

# NER Extraction

Named Entity Recognition pipeline for the OSINT ingestion flow. When an IntelReport is created (e.g., from a tweet), the NER pipeline automatically extracts Person, Organization, Location, and Equipment entities from the report's content text, creates or looks up corresponding ontology objects, and wires them to the report via MentionsPerson/MentionsOrganization/MentionsLocation/MentionsEquipment links.

The pipeline uses a two-pronged approach: compromise (pure JS, ~200KB) for general Person/Organization/Location detection, and a curated YAML gazetteer for military equipment names.

Entity extraction is best-effort and non-blocking -- a failure in NER never prevents the IntelReport from being stored.

## Public API

**Types:**
- `ExtractedEntity` -- A single entity extracted from text: type, name, context, confidence
- `EntityExtractor` -- Contract interface for any NER implementation
- `EntityExtractionResult` -- Processing summary: entitiesExtracted, entitiesCreated, entitiesDedupHit, linksCreated, errors
- `EntityExtractionConfig` -- YAML-configurable settings: enabled, types, minConfidence, maxEntitiesPerReport, minTextLength

**Classes:**
- `WinkExtractor` -- Primary NER extractor using compromise for Person/Organization/Location
- `GazetteerExtractor` -- Military equipment name matching against curated YAML
- `CompositeExtractor` -- Runs multiple extractors, merges and deduplicates results
- `EntityDedupCache` -- In-memory LRU cache (10K entries) preventing duplicate entity creation
- `EntityExtractionService` -- Full pipeline orchestrator: extract -> dedup -> create/lookup entity -> create Mentions* link

## Dependencies

- `compromise` -- Natural language processing for Person/Organization/Place extraction
- `yaml` -- YAML parsing for the equipment gazetteer
- `@openfoundry/spi` -- StorageProvider and RequestContext types
- `@openfoundry/engine` -- ObjectManager and LinkManager types (used via interface contracts)

## Used By

- [[api-gateway]] -- The NER service is initialized during server bootstrap and called from the changeApplier closure for each IntelReport creation
- [[osint-domain-pack]] -- The equipment gazetteer YAML lives in the OSINT domain pack; the twitter-osint.yaml connector config enables entityExtraction

## Key Design Decisions

- [[adr-011-ner-compromise-over-wink]] -- Compromise selected over wink-nlp (lite model lacks NER classification)
- Best-effort extraction: NER failure never blocks IntelReport storage
- Gazetteer-based equipment matching: configurable YAML, no ML model needed
- LRU cache (10K entries) for dedup: prevents duplicate Person/Org/Location/Equipment objects across reports
- EntityExtractor interface: allows swapping NER backends without changing pipeline code

## Test Coverage

- 6 unit test files, 31 NER-specific tests
- Tests cover: compromise extraction (Person/Org/Location), equipment gazetteer matching, composite merging, LRU dedup cache, full service orchestration with mocked ObjectManager/LinkManager

## Sources

- [Source: ner-entity-extraction-plan.md]
- `packages/sync/src/entity-extraction/` -- Implementation files
- `domain-packs/osint/entity-extraction/equipment-gazetteer.yaml`
