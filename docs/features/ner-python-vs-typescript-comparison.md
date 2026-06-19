---
title: NER — Python vs TypeScript/JS Ecosystem Comparison
created: 2026-06-18
last_updated: 2026-06-18
type: spec
status: draft
related_components:
  - sync-engine
  - ner-extraction
  - cel-evaluator
related_features:
  - osint-domain-pack
  - ner-approach-specification
---

# NER — Python vs TypeScript/JS Ecosystem Comparison

## Executive Summary

Python's NER ecosystem is **dramatically superior** to TypeScript/JS for this use case. The gap is not marginal — Python has 3-4 libraries that individually exceed the best available JS option. Running NER as a dedicated Python sidecar service (gRPC or REST) is the right architecture, matching the existing pattern of the CEL evaluator Go sidecar.

**TL;DR:** Python gets us 94% F1 (Flair) or zero-shot arbitrary entity types (GLiNER) with battle-tested libraries. JS tops out at 55-65% (compromise) or 70-80% with an ONNX-wrapped model that's an afterthought in the Python ecosystem.

---

## 1. Head-to-Head Library Comparison

### 1.1 Pure NER Libraries

| Library | Language | F1 (CoNLL-03) | F1 (tweets est.) | Size | Speed (tweets/sec) | Domain Entities | Zero-Shot | Fine-tune |
|---------|----------|---------------|-------------------|------|--------------------|-----------------|-----------|-----------|
| **Flair** | Python | **94.1%** | 80-90% | ~500MB | 50-200/s | 18-class Ontonotes | Yes (TARS) | Yes |
| **spaCy + TRF** | Python | 93-94% | 80-88% | ~500MB | 100-500/s | 18-class | No* | Yes |
| **GLiNER** | Python | 89-91% | 75-85% | **~300MB** | 20-100/s | **Any type** | **Yes** | **Yes** |
| **HF Transformers** | Python | **94%** | 82-90% | 100MB-3GB | 20-200/s | Any (fine-tune) | No* | **Yes** |
| **Stanza** | Python | 92-93% | 78-85% | ~1GB | 10-50/s | 18-class | No | Yes |
|--------------|----------|---------------|-------------------|------|--------------------|-----------------|-----------|-----------|
| compromise | JS/TS | N/A (heuristic) | **55-65%** | 200KB | 10K+/s | 3 types (PER/ORG/LOC) | No | Partially |
| Transformers.js | JS/TS | 91% (CoNLL) | **70-80%** | 110-340MB | 50-100/s | 4 types (PER/ORG/LOC/MISC) | No | No |
| NLP.js | JS/TS | 85-88% | 65-75% | ~50MB | 100-500/s | Configurable (enum/regex) | No | Partially |
| wink-nlp lite | JS/TS | N/A | N/A (no NER) | 1MB | 650K/s | None | No | No |

*spaCy and base HF Transformers don't support zero-shot, but models fine-tuned for specific NER reach the cited F1.

### 1.2 The GLiNER Advantage

GLiNER is the game-changer for this project. It's the only library (Python or JS) that:

1. **Extracts ANY entity type you name** — no pre-defined classes. Tell it "MilitaryUnit", "WeaponSystem", "ConflictZone" and it finds them. This means we support Equipment extraction natively, without a YAML gazetteer.

2. **Zero-shot** — no labeled data, no fine-tuning required. Works out of the box.

3. **Lightweight** — ~300MB model vs 1-3GB for LLMs. Runs on CPU.

4. **Fine-tunable** — can improve on OSINT data with 50-200 labeled examples.

5. **ONNX export** — can export to ONNX for even faster inference.

6. **Has a built-in HTTP server** — `python -m gliner.serve` gives you a production REST endpoint with dynamic batching.

```python
from gliner import GLiNER

model = GLiNER.from_pretrained("gliner-community/gliner_small-v2.5")
text = "Russian T-90M tanks from 4th Guards Tank Division near Bakhmut"

labels = ["Person", "Organization", "MilitaryUnit", "Location", 
          "Equipment", "WeaponSystem", "ConflictZone"]

entities = model.predict_entities(text, labels, threshold=0.5)
# [
#   {"text": "Russian", "label": "Organization"},
#   {"text": "T-90M", "label": "Equipment"},
#   {"text": "4th Guards Tank Division", "label": "MilitaryUnit"},
#   {"text": "Bakhmut", "label": "Location"}
# ]
```

### 1.3 Flair: State-of-the-Art Accuracy

Flair holds the #1 or #2 spot on most NER leaderboards. 94.1% F1 on CoNLL-03, 90.9% on Ontonotes 18-class. It's PyTorch native, meaning GPU acceleration works out of the box.

```python
from flair.data import Sentence
from flair.nn import Classifier

tagger = Classifier.load('ner-large')  # 94.1% F1 model
sentence = Sentence("Russian T-90M tanks near Bakhmut")
tagger.predict(sentence)
# "Russian" -> ORG, "T-90M" -> MISC, "Bakhmut" -> LOC
```

### 1.4 What JS/TS Has

| Tool | Best Use | Limitation |
|------|----------|------------|
| **compromise** | Prototyping, ultra-low-latency filtering | Heuristic, 55-65% accuracy, no domain types |
| **Transformers.js** | Browser-based NER, serverless | Limited model selection, ONNX-only, slower |
| **NLP.js** | Chatbot intent + entity extraction | 50MB, chatbot-focused, NER is secondary |

**There is no JS equivalent of GLiNER, Flair, or spaCy.** The JS ecosystem is 3-5 years behind Python in NLP.

---

## 2. Architecture: Python Sidecar Service

### 2.1 Pattern: Copy Existing CEL Evaluator

The project already uses this pattern. The CEL evaluator is a Go gRPC sidecar at `cel-evaluator:50051`. We mirror it exactly:

```
┌──────────────────────┐         ┌─────────────────────────┐
│   API Gateway (TS)   │  gRPC   │  NER Service (Python)   │
│                      │────────▶│                         │
│  changeApplier       │         │  GLiNER / Flair / spaCy │
│  → entityExtractSv   │◀────────│                         │
│                      │  Proto  │  port 50052             │
└──────────────────────┘         └─────────────────────────┘
```

### 2.2 Implementation Options

**Option A: gRPC (recommended)**

Matches existing CEL evaluator pattern. Fast, typed, streaming support.

```
proto/ner/v1/ner.proto:
  service NerService {
    rpc ExtractEntities(ExtractRequest) returns (ExtractResponse);
    rpc HealthCheck(HealthRequest) returns (HealthResponse);
  }

  message ExtractRequest {
    string text = 1;
    repeated string entity_types = 2;  // ["Person", "Organization", ...]
    float min_confidence = 3;
  }

  message ExtractResponse {
    repeated Entity entities = 1;
  }

  message Entity {
    string type = 1;
    string name = 2;
    float confidence = 3;
    string context = 4;
  }
```

**Option B: REST (simpler, lower performance)**

```
POST /extract
{
  "text": "Russian T-90M tanks near Bakhmut",
  "labels": ["Person", "Organization", "Location", "Equipment"],
  "threshold": 0.5
}
→ {
  "entities": [
    {"type": "Organization", "name": "Russian", "confidence": 0.92},
    {"type": "Location", "name": "Bakhmut", "confidence": 0.95},
    {"type": "Equipment", "name": "T-90M", "confidence": 0.88}
  ]
}
```

**Option C: GLiNER built-in HTTP server (fastest setup)**

```bash
python -m gliner.serve --model gliner-community/gliner_small-v2.5
# Ready on http://localhost:8000/gliner — no code needed
```

### 2.3 Docker Compose Addition

```yaml
ner-service:
  build:
    context: .
    dockerfile: packages/ner-service/Dockerfile
  ports:
    - "50052:50052"
  environment:
    - MODEL=gliner-community/gliner_small-v2.5
    - DEVICE=cpu  # or cuda
    - GRPC_PORT=50052
  volumes:
    - ner_models:/models  # cache downloaded models
  healthcheck:
    test: ["CMD", "grpc-health-probe", "-addr=:50052"]
```

### 2.4 Client Integration in server.ts

```typescript
// Replace current inline EntityExtractionService instantiation
// with a gRPC client:

const { NerServiceClient } = await import('./generated/ner.js');
const nerClient = new NerServiceClient('ner-service:50052', grpc.credentials.createInsecure());

// In changeApplier:
const resp = await nerClient.extractEntities({
  text: reportText,
  entityTypes: ['Person', 'Organization', 'Location', 'Equipment', 'MilitaryUnit'],
  minConfidence: 0.6,
});
```

---

## 3. Recommended Python Stack

**Primary: GLiNER (zero-shot, any entity type)**

```
pip install gliner
model = GLiNER.from_pretrained("gliner-community/gliner_small-v2.5")
```

- Why: Extracts ANY entity type we specify — no hardcoded PER/ORG/LOC. Supports Equipment, MilitaryUnit, WeaponSystem, ConflictZone, ArmedGroup out of the box.
- Model: `gliner_small-v2.5` (~300MB, CPU-friendly)
- Speed: 20-50 tweets/sec on CPU, 200+/sec on GPU
- Accuracy: Comparable to GPT-3.5 on zero-shot NER tasks

**Optional upgrade: Flair (maximum accuracy)**

```
pip install flair
tagger = Classifier.load('ner-large')
```

- Why: 94.1% F1. Best-in-class for standard NER.
- Use case: When you need maximum accuracy on PER/ORG/LOC and can pre-define types.
- Model: `ner-large` (~500MB)

**Stack recommendation:**
- Tier 1 (always): GLiNER zero-shot — extracts all ontology entity types
- Tier 2 (optional upgrade): Flair fine-tuned on OSINT data — for production accuracy
- Fallback: Local equipment gazetteer (YAML) — if Python service is down

---

## 4. Migration Path from Current Implementation

**Current state:**
- `packages/sync/src/entity-extraction/` — compromise + gazetteer, inline in Node.js
- 193 tests passing, live on real tweets

**Migration steps:**

1. **Keep the EntityExtractor interface** — it's already abstract. Swap implementation.

2. **Create `packages/ner-service/`** — Python package with:
   - `requirements.txt`: gliner, grpcio, grpcio-tools
   - `server.py`: gRPC server wrapping GLiNER
   - `Dockerfile`: python:3.12-slim + deps
   - `proto/ner.proto`: gRPC contract

3. **Create gRPC client in TS:**
   - `packages/sync/src/entity-extraction/grpc-extractor.ts`: implements EntityExtractor, calls gRPC
   - `packages/sync/src/entity-extraction/ner-client.ts`: gRPC client wrapper with retry, timeout

4. **Add fallback:**
   - Keep compromise as fallback if gRPC unavailable
   - `FallbackExtractor` wraps gRPC + compromise

5. **Update Docker Compose** with `ner-service`

6. **Update tests** — mock gRPC service or use existing compromise tests for fallback

**Time estimate:** 1 day for gRPC service, 0.5 day for client integration, 0.5 day for Docker setup.

---

## 5. Python vs JS/TS Decision Matrix

| Factor | Python (GLiNER) | Python (Flair) | TS (compromise) | TS (Transformers.js) |
|--------|-----------------|----------------|-----------------|----------------------|
| **Accuracy on tweets** | ★★★★☆ | ★★★★☆ | ★★☆☆☆ | ★★★☆☆ |
| **Domain entity types** | ★★★★★ Zero-shot | ★★★☆☆ 18-class | ★☆☆☆☆ 3 types | ★★☆☆☆ 4 types |
| **Equipment detection** | ★★★★★ Native | ★★★☆☆ MISC bucket | ★☆☆☆☆ No | ★☆☆☆☆ MISC bucket |
| **Fine-tunable** | ★★★★★ | ★★★★★ | ★☆☆☆☆ | ★☆☆☆☆ |
| **Setup complexity** | ★★★☆☆ | ★★★★☆ | ★★★★★ | ★★★☆☆ |
| **Operational complexity** | ★★★☆☆ (service) | ★★★☆☆ (service) | ★★★★★ (inline) | ★★★★☆ (inline) |
| **Offline capable** | ★★★★★ | ★★★★★ | ★★★★★ | ★★★★★* |
| **GPU acceleration** | ★★★★★ | ★★★★★ | N/A | WebGPU only |
| **Ecosystem maturity** | ★★★★★ | ★★★★★ | ★★☆☆☆ | ★★★☆☆ |
| **Production readiness** | ★★★★★ | ★★★★★ | ★★★☆☆ | ★★★☆☆ |

---

## 6. Cost Analysis

| Approach | Setup Cost | Runtime Cost | Accuracy Value |
|----------|-----------|--------------|----------------|
| compromise (current) | Already done | $0/forever | Low (55-65%) |
| Transformers.js BERT-NER | 1 day dev | $0/forever | Medium (70-80%) |
| **Python GLiNER sidecar** | **1-2 days dev** | **$0 + ~500MB RAM** | **High (75-85% + any type)** |
| Python Flair sidecar | 1-2 days dev + training | $0 + ~2GB RAM (GPU optional) | Very High (80-90%) |
| OpenAI API | 0.5 day dev | $2-5/day at scale | Very High (90-98%) |
| Ollama local LLM | 1 day dev | $0 + 4-8GB RAM | High (80-90%) |

---

## 7. Recommendation

**Primary Recommendation: Python GLiNER Service (gRPC sidecar)**

This is the right answer for this project because:

1. **Zero-shot extraction of ANY entity type** — Person, Organization, Location, Equipment, MilitaryUnit, ArmedGroup, WeaponSystem, ConflictZone — all extracted by naming them. This replaces both the compromise extractor AND the equipment gazetteer with a single model.

2. **Matches existing architecture** — the project already has a Go gRPC sidecar (CEL evaluator). Adding a Python gRPC sidecar follows the same proven pattern.

3. **Free + offline** — GLiNER models are Apache 2.0 licensed. No API keys. No rate limits. No network calls after model download.

4. **Fine-tunable** — if OSINT-specific accuracy needs improvement, fine-tune on 100-500 labeled tweets in a few hours.

5. **Production-ready** — GLiNER ships with Ray Serve for dynamic batching, ONNX export for speed, and Docker support.

**The JS/TS compromise solution should be kept as the fallback** — if the Python service is unreachable, the pipeline continues with compromise (exact same interface, lower accuracy, never blocks).

---

## 8. Open Questions

- [ ] gRPC or REST for the Python service? (gRPC matches CEL evaluator pattern but adds protobuf complexity)
- [ ] GPU or CPU for the NER service? (CPU works fine for GLiNER small, GPU for Flair large)
- [ ] Which GLiNER model size? (small ~300MB vs medium ~1GB vs large ~3GB)
- [ ] Keep compromise as fallback or replace entirely?
- [ ] Should the equipment gazetteer YAML be retired after GLiNER deployment?

## Sources

- [Source: ner-approach-specification.md]
- [Source: https://github.com/urchade/GLiNER]
- [Source: https://github.com/flairNLP/flair]
- [Source: https://spacy.io/universe/project/spacy-transformers]
- [Source: https://github.com/huggingface/transformers.js]
- [Source: https://github.com/spencermountain/compromise]
- Live compromise testing on 15 real tweets (2026-06-18)
