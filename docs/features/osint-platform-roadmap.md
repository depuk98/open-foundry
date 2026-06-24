---
title: osint-platform-roadmap
created: 2026-06-20
type: feature
status: draft
related_components:
  - sync-engine
  - ner-extraction
  - ner-service
  - twitter-connector
  - api-gateway
related_features:
  - osint-domain-pack
  - domain-pack-palantir-refactor
related_decisions:
  - adr-013-palantir-domain-pack-refactor
---

# OSINT Platform — Future Proposals & Roadmap

Work identified during the Palantir domain pack refactor that builds on the new architecture.

## P0: Critical Gaps (what's blocking intelligence value)

### 1. Relation Extraction
Currently entities are extracted and linked with flat `Mentions*` links. No semantic relations ("controls", "attacks", "supplies") are extracted. The graph is a bag of entities with "mentioned in report N" edges. The ODL schema already defines 50+ link types — but only `Mentions*` is populated.

**Proposed**: Three-tier approach building on existing infrastructure:

- **Tier 1 (pattern-based, zero cost)**: Verb→relation mapping via compromise.js dependency parsing (already a dependency). Regex patterns for OSINT-formulaic tweet structures:
  - `"X captured/entered/controls Y"` → OrgControlsLocation
  - `"X commands/leads/heads Y"` → KeyPersonnelInOrg
  - `"X uses/operates/deploys Y"` → OrgOperatesEquipment
  - `"X seen/spotted/sighted near Y"` → EquipmentSightedAtLocation
  - `"X belongs to/member of Y"` → PersonBelongsToOrg
  - `"X destroyed/lost near Y"` → EquipmentSightedAtLocation

- **Tier 2 (LLM-based, higher accuracy)**: Extend the existing Python NER gRPC service (`ner-service/server.py`) with an `ExtractRelations` RPC. Reuses the same phi4-mini/Ollama infrastructure already running. Prompt the LLM with extracted entities + tweet text + relation type catalog from ODL schema.

- **Tier 3 (graph inference, cross-report)**: Periodic batch job: "5+ reports of same Equipment in same Location → increment EquipmentSightedAtLocation confidence." Materializes inferred relations with `source='inferred'`.

**Architecture fit**: Relation extraction runs in the `changeApplier` after NER extraction (same pattern). New relations populate the 50 existing ODL link types — no schema changes needed.

### 2. Source Credibility Auto-Scoring
`SourceProfile.credibilityScore` exists but is never populated. All sources default to 0.7. The field is already in the ODL schema with a `@constraint` directive.

**Proposed**: CEL-based computed field or periodic background computation using:
- (a) **Track record**: Ratio of corroborated reports to total reports from this source
- (b) **Cross-source consensus**: How often this source's claims match other sources for the same entities
- (c) **Downranking signals**: Reports flagged as disinformation, retracted, or contradicted

**Architecture fit**: `SourceProfile.credibilityScore` already has `@constraint(expr: "value >= 0.0 && value <= 1.0")`. Could be a `@computed` field recalculated on new reports, or a periodic batch job. The `OsintSourceStatus` enum already handles `ACTIVE`, `SUSPENDED`, `DECOMMISSIONED` states — credibility can auto-trigger state transitions.

## P1: Unlocks Intelligence Products

### 3. Cross-Source Corroboration
Same entity reported by 3+ independent sources = high confidence. Single source = low. The multi-source infrastructure exists (Twitter, Telegram, RSS, ACLED) but no consensus computation.

### 4. Event Detection & Classification
NER gives entities — but what happened? Event extraction via LLM classifies events (battle, protest, diplomatic meeting) and links participants, locations, and equipment.

### 5. Alerting System
Rules-based triggers using ObjectSet + CEL infrastructure: "Equipment T-90M sighted in Location Bakhmut + within 24h → alert webhook/Slack/email."

### 6. LLM-Powered Intelligence Summaries
"Last 24h: 3 reports of T-90M losses near Bakhmut, 2 sources corroborating. Credibility: HIGH." — Generated from the knowledge graph with source citations.

## P2: Quality & Enrichment

### 7. Entity Enrichment (Wikidata, Sanctions DBs)
Background worker enriches newly created entities against external knowledge bases. Populates `Equipment.specifications`, `IntelSubject.dossier`, etc.

### 8. Analyst Review/Feedback Loop
Analysts verify/correct/flag NER-extracted entities. Feedback improves extraction quality over time. Implements `Verifiable` interface.

### 9. Geocoding Pipeline
NER extracts location names ("Bakhmut") with null coordinates. Geocoding via Nominatim populates GeoPoint coordinates for map visualization.

## P3: Interfaces & Cross-Cutting

### 10. Interface Expansion
Add `Verifiable`, `Credible`, `Monitored` interfaces to `core/interfaces/`. Actions target interfaces, not concrete types — one `Corroborate` action works on any Verifiable type.

### 11. Graph Inference (Cross-Report)
Periodic batch job: "Person X mentioned 10+ times in reports from Organization Y's area → suggest PersonBelongsToOrg with inferred confidence."

### 12. Additional Connectors
- Telegram (MTProto client) — already partially configured
- RSS (polling-based) — already partially configured
- Reddit, Discord — future

## Dependency Map

```
NOW ──────► P0 ──────► P1 ──────► P2 ──────► P3
                              │
Entity Extraction             │
+ Dual Creates                │
+ Core Person                 │
                              ▼
              Relation Extraction → Source Credibility → Cross-Source Corroboration
                                                           │
                                                           ▼
                                          Event Detection → Alerting → LLM Summaries
                                                           │
                                                           ▼
                                          Entity Enrichment → Analyst Review → Geocoding
                                                           │
                                                           ▼
                                          Interfaces → Graph Inference → Connectors
```

## Sources

- [[domain-pack-palantir-refactor]]
- [[adr-013-palantir-domain-pack-refactor]]
- [[osint-domain-pack]]

---

## Appendix: Intelligence Cycle Mapping

The NATO/DoD intelligence cycle provides the framework. Below is how the roadmap maps to each phase:

| Phase | What It Means | Current State | Roadmap Items |
|-------|--------------|---------------|---------------|
| **Direction** | What to look for (intelligence requirements) | ❌ Missing | Future: IntelligenceRequirement ODL type, priority-based collection planning |
| **Collection** | Gather raw data | ✅ Twitter connector, 🔜 Telegram, 🔜 RSS | #12 Additional Connectors |
| **Processing** | Translate, evaluate, collate | ✅ NER extraction, ⚠️ No translation, ⚠️ No source eval | #1 Relation Extraction, #2 Source Credibility |
| **Analysis** | Significance, patterns, interpretation | ❌ Missing entirely | #3 Cross-Source Corroboration, #4 Event Detection, #7 Entity Enrichment, #10 Interfaces, #11 Graph Inference |
| **Dissemination** | Reports, alerts, products | ⚠️ API exists but no products | #5 Alerting, #6 LLM Summaries, #8 Analyst Review |
| **Feedback** | Revise requirements, improve | ❌ Missing | #8 Analyst Review Loop |

---

## Appendix: Persona & Interface Alignment

The platform targets 3 personas (from `docs/vision.md`):

| Persona | Primary Need | Roadmap Priority |
|---------|-------------|-----------------|
| **Independent researchers** | Fast entity lookup, timeline construction, source verification | Relation extraction, cross-source corroboration |
| **Journalists** | Narrative synthesis, evidence chain, credibility assessment | LLM summaries, source credibility, analyst review |
| **Government analysts** | Alerting, threat scoring, classified intelligence production | Alerting, event detection, entity enrichment, interfaces |

**3 interfaces** (from `docs/vision.md`):

| Interface | Purpose | Blocked By | Implemented As |
|-----------|---------|-----------|----------------|
| **Visual dashboard** | Map view + timeline + graph visualization | Geocoding (#9), Relation extraction (#1) | Frontend app consuming GraphQL API |
| **API-first** | Programmatic access for researchers/tools | Already exists (GraphQL + REST) | Auto-generated from ODL schema |
| **AI chat** | LLM + ontology tool access via MCP | Entity enrichment (#7), LLM summaries (#6) | MCP server exposing action executor + query engine |
