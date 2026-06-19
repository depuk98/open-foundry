---
title: Three-Stage NER Pipeline — Parallel GLiNER + Flair + LLM Verification
created: 2026-06-18
last_updated: 2026-06-18
type: spec
status: draft
related_components:
  - ner-extraction
  - sync-engine
  - api-gateway
related_features:
  - osint-domain-pack
  - ner-python-vs-typescript-comparison
  - ner-approach-specification
---

# Three-Stage NER Pipeline: Parallel GLiNER + Flair + LLM Verification

## 1. Objective

When a tweet says *"Russian T-90M tanks from 4th Guards Tank Division near Bakhmut by Ukrainian HIMARS strike"*, extract all entities with maximum accuracy by running GLiNER and Flair in parallel, merging results, and having a lightweight LLM perform final verification, conflict resolution, and correction.

**Core insight:** GLiNER excels at domain-specific types (Equipment, WeaponSystem, MilitaryUnit) but with moderate confidence. Flair excels at standard types (PER/ORG/LOC) with very high confidence. An LLM adjudicates conflicts, fills gaps, and verifies correctness in ways no single model can.

**Success criteria:**
- >85% precision on OSINT tweet text (up from current 55-65% with compromise)
- Extract Equipment, WeaponSystem, MilitaryUnit, ArmedGroup, ConflictZone as first-class entity types
- Zero false positives for empty/short/noisy text
- Latency: <500ms per tweet (parallel GLiNER + Flair + LLM)
- Pipeline never blocks ingestion

---

## 2. The Architecture

### 2.1 Three-Stage Pipeline

```
                          IntelReport Text
                                |
                +---------------+---------------+
                |               |               |
                v               v               |
        +--------------+ +--------------+      |
        | Stage 1a      | | Stage 1b      |     |
        | GLiNER        | | Flair         |     |
        | (32ms)        | | (75ms)        |     |
        |               | |               |     |
        | Zero-shot     | | 94.1% F1      |     |
        | Equipment     | | PER/ORG/LOC   |     |
        | WeaponSys     | | MISC bucket   |     |
        | MilitaryUnit  | | High conf.    |     |
        +-------+-------+ +-------+-------+     |
                |                 |             |
                +--------+--------+             |
                         |                      |
                         v                      |
                +--------------+                |
                | Stage 2      |                |
                | Ensemble     |                |
                | Merge        |                |
                |              |                |
                | Union sets   |                |
                | Resolve      |                |
                | overlaps     |                |
                | Flag conflicts|               |
                +-------+------+                |
                        |                       |
                        v                       |
                +--------------+                |
                | Stage 3      |                |
                | LLM Reviewer |                |
                | (50-200ms)   |                |
                |              |                |
                | Small model  |                |
                | 2-4B params  |                |
                | Local/Ollama |                |
                |              |                |
                | Verify       |                |
                | Correct      |                |
                | Fill gaps    |                |
                | Resolve      |                |
                +-------+------+                |
                        |                       |
                        v                       |
               Final Entity Set -->
               Create/Link in Knowledge Graph
```

### 2.2 Why Three Stages?

LLMs are excellent at verification/correction with constrained input, but poor at extraction from scratch (hallucination risk). GLiNER+Flair provide the constrained candidate set; the LLM only judges and refines.

| Stage | Strengths | Weaknesses | Resolved by |
|-------|-----------|-----------|------------|
| **GLiNER** | Zero-shot, any type, domain entities | Moderate confidence, occasional false positives | Flair cross-check + LLM verification |
| **Flair** | Very high confidence, best PER/ORG/LOC | No domain types, MISC bucket | GLiNER types MISC correctly + LLM disambiguation |
| **LLM Reviewer** | Context understanding, conflict resolution, gap filling | Slower, hallucination risk on open extraction | GLiNER+Flair candidates constrain it |

---

## 3. Stage 1: Parallel Extraction

### 3.1 GLiNER

```
Labels: [Person, Organization, Location, Equipment, WeaponSystem,
         MilitaryUnit, ArmedGroup, ConflictZone, Event]

Input: "Russian T-90M tanks from 4th Guards Tank Division near Bakhmut"

Output:
  Organization:  "Russian"           conf: 0.94
  Equipment:     "T-90M"             conf: 0.88
  MilitaryUnit:  "4th Guards Tank Div" conf: 0.91
  Location:      "Bakhmut"           conf: 0.97
  Organization:  "Ukrainian"         conf: 0.82
  WeaponSystem:  "HIMARS"            conf: 0.86
```

### 3.2 Flair

```
Tags: PER, ORG, LOC, MISC

Same input:

Output:
  MISC:  "Russian"                  conf: 1.00
  MISC:  "T-90M"                    conf: 0.99
  ORG:   "4th Guards Tank Div"      conf: 0.96
  LOC:   "Bakhmut"                  conf: 0.99
  MISC:  "Ukrainian"                conf: 1.00
  MISC:  "HIMARS"                   conf: 0.95
```

### 3.3 Parallel Execution

```
Wall-clock: ~75ms (limited by slower Flair)
asyncio.gather(gliner_task, flair_task)
```

---

## 4. Stage 2: Ensemble Merge

### 4.1 Merge Strategy

```
For each unique (span, type) pair:

  1. Both agree on span AND type:
     -> ACCEPT with max(confidence_g, confidence_f)
     -> Status: CONFIRMED

  2. Only one model found the span:
     -> ACCEPT if confidence >= threshold
     -> Status: SINGLE_SOURCE

  3. Both found span but DIFFERENT types:
     -> MARK as CONFLICT
     -> Status: NEEDS_REVIEW (-> Stage 3)

  4. Flair says MISC, GLiNER has specific type:
     -> ACCEPT GLiNER type with boosted confidence
     -> Status: GLINER_ENRICHED
```

### 4.2 Type Mapping (GLiNER label -> Flair tag -> Resolved)

| GLiNER Label | Flair Tag | Resolved Type | Priority |
|-------------|-----------|---------------|----------|
| Person | PER | Person | CONFIRMED |
| Organization | ORG | Organization | CONFIRMED |
| Location | LOC | Location | CONFIRMED |
| Equipment | MISC | **Equipment** | GLiNER enriches |
| WeaponSystem | MISC | **WeaponSystem** | GLiNER enriches |
| MilitaryUnit | ORG | **MilitaryUnit** | GLiNER subtypes ORG |
| ArmedGroup | ORG | **ArmedGroup** | GLiNER subtypes |
| ConflictZone | LOC | **ConflictZone** | GLiNER subtypes LOC |

### 4.3 Conflict Resolution Rules (Stage 2, pre-LLM)

| Scenario | Rule | Example |
|----------|------|---------|
| GLiNER:Person / Flair:ORG | Trust Flair (higher std F1) | "@NATO" -> Flair ORG wins |
| GLiNER:Location / Flair:MISC | Trust GLiNER (more specific) | "Donbas" -> GLiNER Location wins |
| GLiNER:Equipment / Flair:MISC | Trust GLiNER (domain) | "T-90M" -> GLiNER Equipment wins |
| Both < 0.5 confidence | Discard both | Noisy span |
| Disagreement, ambiguous | Flag for LLM (Stage 3) | "Wagner" -> GLiNER:Person, Flair:ORG |

---

## 5. Stage 3: LLM Verification

### 5.1 The LLM's Role

The LLM receives the **merged candidate set from Stage 2** + **original text**:

1. **Verify:** Are these real entities in context? Filter false positives.
2. **Correct:** "President" alone -> what full name? Fix partial extractions.
3. **Resolve:** GLiNER says Person, Flair says ORG -> which is it?
4. **Fill gaps:** Did both models miss something obvious? (use sparingly)
5. **Disambiguate:** "Russia" appears twice in text -> Org or Location in this sentence?

### 5.2 LLM Prompt Template

```
SYSTEM:
You are an NER verification agent. Review entity candidates against the
original text. Your job:
- CONFIRM: entity span and type are correct
- CORRECT: span or type is wrong -> provide corrected version
- REJECT: entity is a false positive -> remove
- ADD: obvious entity missed by both extractors (use sparingly, only
  if extremely obvious and both models clearly missed it)

Entity types: Person, Organization, Location, Equipment, WeaponSystem,
              MilitaryUnit, ArmedGroup, ConflictZone, Event

Output STRICT JSON array only, no other text:
[
  {
    "text": "exact text span",
    "type": "EntityType",
    "confidence": 0.X,
    "action": "confirm|correct|reject|add",
    "reasoning": "brief one-line explanation"
  }
]

USER:
Original text: "{text}"

Candidate entities:
{candidates_formatted}
```

### 5.3 Suitable Lightweight LLMs

| Model | Params | RAM | CPU Speed | Quality | Best For |
|-------|--------|-----|-----------|---------|----------|
| **phi4-mini** | 3.8B | ~3GB | 20-40 t/s | ★★★★☆ | **Primary pick** - best JSON + instruction following |
| **llama3.2:3b** | 3B | ~3GB | 15-30 t/s | ★★★★☆ | Strong reasoning, fast |
| **gemma2:2b** | 2B | ~2GB | 40-60 t/s | ★★★☆☆ | Fastest, weakest reasoning |
| **qwen2.5:3b** | 3B | ~3GB | 20-35 t/s | ★★★★☆ | Best multilingual (Ukrainian/Russian/Arabic) |

**Primary: phi4-mini** (~3GB, 20-40 t/s on M1). For NER verification which is ~100-200 tokens per call, that's ~50-100ms. Combined with Stage 1's 75ms, total pipeline latency is ~125-175ms.

**Fallback: gemma2:2b** (~2GB, 40-60 t/s). Faster but weaker on disambiguation.

### 5.4 When to Skip Stage 3

The LLM is skipped when:
- **All entities CONFIRMED** (both models agree, high confidence): skip LLM, use Stage 2 output directly. This is the common case (~70-80% of tweets).
- **No entities found** by Stage 1: nothing to verify.
- **No conflicts**: Stage 2 resolved everything at high confidence.
- **Config flag:** `entityExtraction.llm.reviewOnlyConflicts: true` (default)

This optimization means the LLM only runs on ~20-30% of tweets — the ones with conflicts, low confidence, or disagreements.

---

## 6. Complete Flow: Per-Entity Lifecycle

```
Input: "Russian T-90M near Bakhmut, Ukraine said yesterday"

STAGE 1 (parallel, 75ms wall):
  GLiNER:  [Org:Russian 0.94, Equip:T-90M 0.88, Loc:Bakhmut 0.97,
            Loc:Ukraine 0.99, Org:Ukraine 0.82, Person:yesterday 0.42]
  Flair:   [MISC:Russian 1.00, MISC:T-90M 0.99, LOC:Bakhmut 0.99,
            LOC:Ukraine 1.00, MISC:Ukrainian 1.00, DATE:yesterday 1.00]

STAGE 2 (merge, <1ms):
  Russian     CONFIRMED (both, Org via GLiNER enriches Flair MISC)
  T-90M       CONFIRMED (both, Equipment via GLiNER enriches Flair MISC)
  Bakhmut     CONFIRMED (both LOC)
  Ukraine     CONFLICT  (GLiNER:Loc+Org, Flair:LOC) -> NEEDS_REVIEW
  Ukrainian   SINGLE_SOURCE (GLiNER Org 0.82) -> ACCEPT
  yesterday   REJECT     (GLiNER Person 0.42 < threshold, Flair DATE -> not our type)

STAGE 3 (LLM, 50-100ms, only if conflicts exist):
  Input:  text + 5 candidates + 1 conflict (Ukraine: Loc vs Org)

  LLM response:
  [
    {"text":"Russian","type":"Organization","action":"confirm","confidence":0.97,
     "reasoning":"Used attributively as military force in this sentence"},
    {"text":"T-90M","type":"Equipment","action":"confirm","confidence":0.99,
     "reasoning":"Clearly military equipment"},
    {"text":"Bakhmut","type":"Location","action":"confirm","confidence":0.99,
     "reasoning":"Unambiguous location"},
    {"text":"Ukraine","type":"Organization","action":"correct",
     "confidence":0.85,
     "reasoning":"Used as political entity speaking, not geographic location"},
    {"text":"Ukrainian","type":"Organization","action":"confirm","confidence":0.90,
     "reasoning":"Attributive reference to Ukrainian military forces"}
  ]

FINAL (5 entities, ~150ms total):
  Organization:  Russian (0.97)
  Equipment:     T-90M   (0.99)
  Location:      Bakhmut (0.99)
  Organization:  Ukraine (0.85)
  Organization:  Ukrainian (0.90)
```

**What the LLM did:**
- Verified 5 entities correctly
- Resolved Ukraine conflict: chose Organization (political entity speaking) over Location
- Did NOT add anything (no gap-filling needed here)
- Removed "yesterday" false positive from GLiNER

---

## 7. Tradeoffs & Cost Analysis

### 7.1 Accuracy vs Latency vs Cost

| Configuration | Precision (est.) | Latency/tweet | RAM | Cost |
|--------------|-----------------|---------------|-----|------|
| compromise only (current) | 55-65% | 0.1ms | 0 | $0 |
| GLiNER only | 75-80% | 32ms | 1.5GB | $0 |
| Flair only | 80-85% | 75ms | 2GB+ | $0 |
| GLiNER + Flair (Stage 1+2) | 82-88% | 75ms | 3.5GB | $0 |
| **Full 3-stage (recommended)** | **85-92%** | **75-175ms** | **6.5GB** | **$0** |
| GLiNER + Flair + GPT-4o-mini | 90-95% | 500-800ms | 3.5GB | ~$0.001/tweet |
| GPT-4 alone (no pipeline) | 88-95% | 500ms | 0 | ~$0.005/tweet |

### 7.2 The phi4-mini Efficiency

phi4-mini is a 3.8B model optimized for edge deployment. For our NER verification task:
- Input: ~100 tokens (system prompt)
- Output: ~200 tokens (JSON array with 5-8 entities)
- At 30 t/s on Apple Silicon: ~100ms per call
- 3GB RAM overhead in Ollama
- Only invoked on ~20-30% of tweets (conflicts only)
- **Effective cost: $0 + 3GB RAM**

### 7.3 What We Trade Off

**Costs of the 3-stage approach:**
- 2 Python libraries to load at startup (GLiNER + Flair = ~3.5GB models)
- 1 Ollama model to load (phi4-mini = ~3GB)
- Total: ~6.5GB RAM for the NER service container
- ~200ms latency vs current 0.1ms (compromise) — but still fast for 5 tweets/sec ingestion
- Increased Docker image size (Python + PyTorch + Flair + GLiNER)

**Benefits:**
- 85-92% precision vs 55-65% (compromise) or 75-85% (single model)
- Equipment/WeaponSystem/MilitaryUnit as first-class types
- LLM resolves ambiguities that rule-based systems cannot
- Zero external API costs — everything runs locally
- Graduated fallback: each stage can fail independently without blocking

---

## 8. Fallback Chain (Never Blocks)

```
Tweet ingested
  |
  Try Stage 1 (GLiNER + Flair, parallel)
  |-- GLiNER fails -> run Flair solo
  |-- Flair fails -> run GLiNER solo
  |-- Both fail -> fall back to compromise (Stage 1b, inline JS)
  |
  Try Stage 2 (Ensemble merge)
  |-- If only one model ran -> skip merge, use single output
  |
  Try Stage 3 (LLM verification)
  |-- LLM unavailable -> use Stage 2 output as-is
  |-- LLM timeout (500ms) -> use Stage 2 output
  |-- LLM returns invalid JSON -> retry once, then use Stage 2
  |
  Report stored. Entities are bonus.
```

---

## 9. Docker Architecture

```yaml
# deploy/docker-compose.yaml additions

ner-service:
  build:
    context: ..
    dockerfile: packages/ner-service/Dockerfile
  ports:
    - "50052:50052"
  environment:
    - GLINER_MODEL=gliner-community/gliner_small-v2.5
    - FLAIR_MODEL=ner-large
    - LLM_PROVIDER=ollama
    - LLM_MODEL=phi4-mini
    - LLM_ENDPOINT=http://ollama:11434
    - DEVICE=cpu
    - GRPC_PORT=50052
  volumes:
    - ner_models:/models
  depends_on:
    ollama:
      condition: service_healthy
  healthcheck:
    test: ["CMD", "grpc-health-probe", "-addr=:50052"]
  deploy:
    resources:
      limits:
        memory: 8G

ollama:
  image: ollama/ollama:latest
  ports:
    - "11434:11434"
  volumes:
    - ollama_data:/root/.ollama
  environment:
    - OLLAMA_KEEP_ALIVE=24h
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:11434/api/tags"]
  deploy:
    resources:
      limits:
        memory: 6G

volumes:
  ner_models:
  ollama_data:
```

---

## 10. gRPC Contract

```protobuf
syntax = "proto3";
package ner.v1;

service NerService {
  rpc ExtractEntities(ExtractRequest) returns (ExtractResponse);
  rpc HealthCheck(HealthRequest) returns (HealthResponse);
}

message ExtractRequest {
  string text = 1;
  repeated string labels = 2;  // from YAML config
  float min_confidence = 3;    // default 0.4
  int32 max_entities = 4;      // default 20
  bool enable_llm_review = 5;  // whether to invoke Stage 3
}

message ExtractResponse {
  repeated Entity entities = 1;
  PipelineMetadata metadata = 2;
}

message Entity {
  string text = 1;
  string type = 2;
  float confidence = 3;
  string context = 4;
  EntityStatus status = 5;     // CONFIRMED, SINGLE_SOURCE, LLM_VERIFIED, etc.
}

enum EntityStatus {
  UNKNOWN = 0;
  CONFIRMED = 1;           // both GLiNER and Flair agree
  SINGLE_SOURCE = 2;       // only one model found it
  GLINER_ENRICHED = 3;     // Flair MISC typed by GLiNER
  LLM_VERIFIED = 4;        // LLM confirmed
  LLM_CORRECTED = 5;       // LLM changed type or span
  LLM_ADDED = 6;           // LLM added missing entity
  CONFLICT_RESOLVED = 7;   // LLM resolved type conflict
}

message PipelineMetadata {
  int32 gliner_count = 1;
  int32 flair_count = 2;
  int32 conflicts = 3;
  int32 llm_reviewed = 4;
  int32 final_count = 5;
  float stage1_latency_ms = 6;
  float stage3_latency_ms = 7;
  bool llm_invoked = 8;
}
```

---

## 11. Comparison to Current Implementation

| Aspect | Current (compromise) | Proposed 3-Stage |
|--------|---------------------|------------------|
| Precision | 55-65% | **85-92%** |
| Entity types | 3 (PER/ORG/LOC) | **9** (incl. Equipment, WeaponSystem, etc.) |
| Equipment detection | YAML gazetteer (regex) | ML-based zero-shot |
| Conflict resolution | None | Rule-based + LLM adjudication |
| Latency | 0.1ms | 75-175ms (still fast for 5 tweets/sec) |
| RAM | 0 (inline JS) | ~6.5GB (Python service + Ollama) |
| External deps | 0 | 0 (all local) |
| Fallback | N/A | compromise as ultimate fallback |
| Maintainability | YAML file to update | Label definitions in config |

---

## 12. Open Questions

- [ ] 6.5GB RAM acceptable for NER service Docker container?
- [ ] Use GPU if available (CUDA/MPS) or enforce CPU-only?
- [ ] Skip Stage 3 entirely for CONFIRMED-only results (performance vs accuracy tradeoff)?
- [ ] phi4-mini or llama3.2:3b for the LLM reviewer?
- [ ] Add Ollama to docker-compose or run as separate infrastructure service?
- [ ] Fine-tune GLiNER on OSINT data before or after 3-stage deployment?
- [ ] Should the LLM reviewer be configurable per-connector (some sources need it more)?

## 13. Risk Matrix

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| LLM hallucinates false entities | Low | Medium | Constrained input (only review candidates, not open extraction). Add strict JSON schema enforcement. |
| LLM slow under load | Medium | Low | Skip Stage 3 when all entities CONFIRMED (70-80% of tweets). Timeout at 500ms. |
| 6.5GB RAM too high for deployment | Medium | Medium | Drop Flair if needed (GLiNER solo + LLM = ~4.5GB). Use gemma2:2b instead of phi4-mini (saves 1GB). |
| Flair + GLiNER + Ollama all in one Docker = too heavy | Medium | Medium | Split into two containers: ner-service (GLiNER+Flair) + ollama (LLM). |
| Cold start: model downloads at first boot | One-time | Low | Bake models into Docker image or use persistent volumes. Accept 2-5 min first boot. |
| phi4-mini JSON output not parseable | Low | Medium | Retry with stricter prompt. Fall back to Stage 2 output. Validate with json.loads before accepting. |

