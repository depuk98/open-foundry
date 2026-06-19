---
title: ADR-010 — OSINT Domain Pack Entity Model Design
created: 2026-06-17
type: decision
status: accepted
related_components:
  - odl
  - ontology-engine
  - sync-engine
related_features:
  - osint-domain-pack
---

# ADR-010: OSINT Domain Pack Entity Model — 10 Object Types vs Simpler Flat Model

## Context

The OSINT domain pack needed an entity model for geopolitical intelligence. Tweets and Telegram messages contain mentions of persons, organizations, locations, and equipment. The question was: how rich should the entity model be?

## Decision

Use a **10-object-type model** with full relational linking (35 link types), inspired by STIX 2.1 and intelligence analysis workflows.

### The 10 object types

1. **IntelReport** — Raw intelligence from a feed (tweet, Telegram message, RSS article)
2. **SourceProfile** — Who/what provided the intel, with credibility scoring
3. **Person** — Individuals: political figures, military commanders, journalists
4. **Organization** — Military units, government agencies, armed groups, corporations
5. **Location** — Geospatial points of interest: cities, bases, conflict zones
6. **Event** — Discrete incidents: battles, airstrikes, protests, diplomatic meetings
7. **Equipment** — Military equipment and weapon systems with operator/sighting tracking
8. **Assessment** — Intelligence products synthesizing multiple reports
9. **Narrative** — Disinformation/misinformation campaign tracking
10. **Indicator** — Early warning triggers with CEL threshold expressions

### Why this structure

- **IntelReport** is the atomic unit — every ingested item becomes one
- **SourceProfile** decouples source credibility from the report itself
- **Person/Org/Location/Equipment** are the entity types that NER will extract
- **Event** aggregates multiple reports about the same incident
- **Assessment** models the intelligence analyst's synthesis workflow
- **Narrative** tracks disinformation campaigns separately from individual reports
- **Indicator** enables programmatic monitoring of ontology data

## Alternatives Considered

### Alternative A: Flat model — just IntelReport with tags (Rejected)
- **Pros**: Simplest to implement, no link management needed
- **Cons**: Cannot query "all reports mentioning this organization", cannot track source credibility independently, cannot link corroborating reports, cannot model analyst workflows
- **Why rejected**: No semantic value beyond a text search engine. Defeats the purpose of a knowledge graph.

### Alternative B: 3-type model — Report + Source + Tag (Rejected)
- **Pros**: Simpler than 10 types, less NER complexity
- **Cons**: Tags conflate persons, orgs, locations, and equipment. No event aggregation. No assessment workflow.
- **Why rejected**: Still not rich enough for intelligence analysis queries.

### Alternative C: 10-type model with STIX-inspired linking (Chosen)
- **Pros**: Rich semantic graph enables complex queries ("all equipment operated by orgs involved in events within 50km of Location X"), models the full intelligence lifecycle
- **Cons**: More complex schema, more link types to maintain, NER extraction needed for entity population
- **Why chosen**: The Open Foundry platform is designed for rich semantic models. The schema is the product. Domain packs that are too simple don't demonstrate the platform's value.

## Consequences

### What becomes easier
- Cross-referencing reports by entity, source, location, and time
- Source credibility tracking across reports
- Analyst workflow support (corroboration, assessment creation, escalation)
- Disinformation tracking as a first-class concept
- Graph queries: "find all reports corroborating this one" or "what equipment has been sighted in this region"

### What becomes harder
- Initial schema design complexity (35 link types)
- Entity extraction requires NER pipeline (not yet implemented — see [[osint-domain-pack]] roadmap)
- Each new data source needs mapping to the entity model
- Many tables remain empty until NER is implemented

## Sources

- `domain-packs/osint/schema/` — All ODL schema files
- STIX 2.1 specification — Inspiration for entity model structure
- `domain-packs/osint/pack.yaml` — Pack manifest with provides counts
