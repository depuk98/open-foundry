---
title: NER Pipeline Uses Compromise Over Wink NLP
created: 2026-06-18
last_updated: 2026-06-18
type: decision
status: accepted
related_components:
  - ner-extraction
  - sync-engine
related_features:
  - osint-domain-pack
  - ner-entity-extraction-plan
---

# ADR 011: Compromise Library for NER Instead of Wink NLP

## Context

The `ner-entity-extraction-plan` originally specified wink-nlp + wink-eng-lite-web-model for Person/Organization/Location entity extraction. During implementation testing, the wink-eng-lite-web-model's entities() API returned only DATE entities -- no PER/ORG/LOC/GPE classification was available. The model's entityType on tokens echoed the token text rather than classifying entity types.

The core requirements were:
- Pure JavaScript (no native extensions)
- Zero network calls (self-contained model)
- No API keys or external services
- Person, Organization, Location classification

## Decision

Switch to compromise (npm: compromise) for the NER implementation.

## Alternatives Considered

- **wink-nlp + wink-eng-lite-web-model** -- Rejected: lite model lacks NER type classification. The non-web model does not exist on npm.
- **natural** -- Rejected: larger dependency footprint, less active maintenance.
- **node-nlp (NLP.js)** -- Rejected: much larger (~50MB), includes many languages we don't need.
- **compromise** -- Selected: ~200KB, pure JS, provides .people()/.organizations()/.places() APIs, actively maintained (4000+ stars), MIT licensed.

## Consequences

**Easier:**
- Simple API: nlp(text).people().out('array') for entity extraction
- Small footprint (~200KB vs ~3MB for wink-nlp)
- POS tagging also available for potential future enhancements

**Harder:**
- Slightly lower accuracy on informal/short text (tweets) compared to dedicated NER models
- Entity extraction is heuristic-based, not deep-learning based
- Does not provide confidence scores natively -- we compute synthetic confidence based on name length and word count

## Sources

- [Source: ner-entity-extraction-plan.md]
- wink-nlp implementation testing (2026-06-18 session)
