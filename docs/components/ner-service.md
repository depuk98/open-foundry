---
title: NER Service
created: 2026-06-18
last_updated: 2026-06-18
type: component
package: "@openfoundry/ner-service"
status: active
related_components:
  - ner-extraction
  - sync-engine
  - api-gateway
  - cel-evaluator
related_features:
  - osint-domain-pack
  - ner-three-stage-pipeline-spec
related_decisions:
  - adr-012-ner-python-sidecar
---

# NER Service

Python gRPC sidecar service providing three-stage named entity recognition for the OSINT ingestion pipeline. Extracts Person, Organization, Location, Equipment, WeaponSystem, MilitaryUnit, ArmedGroup, ConflictZone, and Event entities from raw text.

The service follows the same gRPC sidecar pattern as the CEL evaluator (Go), running as a dedicated Docker container on port 50052.

## Architecture

```
Stage 1: GLiNER (zero-shot) + Flair (94.1% F1) — parallel extraction
Stage 2: Ensemble merge — confidence-weighted union, conflict detection
Stage 3: phi4-mini LLM verification — conflicts only, via host Ollama
```

## Public API (gRPC)

**Service:** `ner.v1.NerService`
**RPC:** `ExtractEntities(ExtractRequest) returns (ExtractResponse)`

```protobuf
message ExtractRequest {
  string text = 1;
  repeated string labels = 2;      // entity types to extract
  float min_confidence = 3;        // 0.0-1.0
  int32 max_entities = 4;          // max entities to return
  bool enable_llm_review = 5;      // invoke Stage 3 LLM
}
```

## Configuration

All settings via environment variables. See `packages/ner-service/config.py` for full list.

| Variable | Default | Description |
|----------|---------|-------------|
| `GRPC_PORT` | 50052 | gRPC listen port |
| `GLINER_MODEL` | gliner-community/gliner_small-v2.5 | GLiNER model ID |
| `FLAIR_MODEL` | ner-large | Flair model name |
| `OLLAMA_HOST` | host.docker.internal:11434 | Ollama API endpoint |
| `OLLAMA_MODEL` | phi4-mini | LLM model for Stage 3 |
| `ENABLE_FLAIR` | true | Load Flair model |
| `ENABLE_LLM` | true | Enable Stage 3 LLM review |
| `MIN_CONFIDENCE` | 0.4 | Default confidence threshold |
| `LLM_TIMEOUT_SECONDS` | 3.0 | Ollama API timeout |

## Deployment

```bash
docker compose up -d --build
```

The service requires:
- 6.5GB+ RAM (GLiNER ~300MB + Flair ~500MB + phi4-mini via host Ollama ~3GB)
- Host Ollama running with `phi4-mini` model pulled
- First boot: models download from HuggingFace (~5 min, cached on subsequent starts)
- Health check: `start_period: 420s`, probe via `grpc-health-probe -addr=:50052`

## Test Coverage

- 40 Python pytest tests (ensemble_merge.py, llm_reviewer.py)
- 16 TypeScript vitest tests (ner-grpc-client.ts, grpc-extractor.ts)
- E2E integration script at `tools/test-ner-through-grpc.py`

## Sources

- `packages/ner-service/` — Implementation
- `packages/ner-service/proto/ner.proto` — gRPC contract
- `docs/features/ner-three-stage-pipeline-spec.md` — Technical specification
