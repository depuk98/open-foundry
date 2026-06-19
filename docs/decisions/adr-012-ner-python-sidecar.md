---
title: Python gRPC Sidecar for Three-Stage NER Pipeline
created: 2026-06-18
type: decision
status: accepted
related_components:
  - ner-service
  - ner-extraction
  - cel-evaluator
related_features:
  - osint-domain-pack
  - ner-three-stage-pipeline-spec
---

# ADR 012: Python gRPC Sidecar for Three-Stage NER Pipeline

## Context

The OSINT ingestion pipeline needs entity extraction from raw tweet text. The initial implementation used compromise (pure JS, inline, ~55-65% accuracy). After researching alternatives, Python's NER ecosystem proved dramatically superior with GLiNER (zero-shot, any entity type) and Flair (94.1% F1), plus phi4-mini for verification.

The project already has a Go gRPC sidecar pattern (CEL evaluator at port 50051). Adding a Python gRPC sidecar for NER follows the same proven architecture.

## Decision

Deploy a Python gRPC service as a Docker container in the existing Compose stack, running a three-stage pipeline: GLiNER + Flair parallel extraction (Stage 1), ensemble merge (Stage 2), and phi4-mini LLM verification via host Ollama (Stage 3, conflicts only).

The TS client mirrors the CEL evaluator's `@grpc/grpc-js` + `@grpc/proto-loader` pattern exactly. The `EntityExtractor` interface remains unchanged — `GrpcNerExtractor` is a drop-in implementation with compromise as fallback.

## Alternatives Considered

- **Pure TypeScript inline (compromise):** Currently implemented. 55-65% accuracy, 3 entity types. Rejected as insufficient for OSINT use case.
- **Transformers.js BERT-NER in Node.js:** 70-80% accuracy but limited model selection (ONNX-only), no domain types (Equipment, MilitaryUnit, etc.), no zero-shot capability.
- **REST API instead of gRPC:** Simpler but slower, no streaming, doesn't match existing CEL evaluator pattern.
- **Ollama in Docker Compose:** Rejected — user already runs host Ollama. Using host avoids duplicate instances and shared model storage.

## Consequences

**Easier:**
- GLiNER zero-shot extracts any entity type by name — no more YAML gazetteer maintenance
- Flair provides 94.1% F1 standard NER as a quality floor
- phi4-mini adjudicates conflicts that rule-based systems cannot resolve
- 9 entity types extracted vs 3, with subtype discriminators (MILITARY_UNIT, ARMED_GROUP, CONTESTED)

**Harder:**
- Python service adds ~6.5GB RAM requirement to the deployment
- First-boot model downloads take ~5 minutes (cached on subsequent starts)
- Need to keep host Ollama running with phi4-mini model pulled
- Two language ecosystems to maintain (Python + TypeScript)

## Sources

- `docs/features/ner-python-vs-typescript-comparison.md`
- `docs/features/ner-three-stage-pipeline-spec.md`
- `docs/decisions/adr-011-ner-compromise-over-wink.md`
