---
title: NER Entity Extraction — Technical Research & Approach Specification
created: 2026-06-18
last_updated: 2026-06-18
type: spec
status: draft
related_components:
  - sync-engine
  - ner-extraction
  - api-gateway
  - ontology-engine
  - twitter-connector
related_features:
  - osint-domain-pack
related_decisions:
  - adr-011-ner-compromise-over-wink
---

# NER Entity Extraction — Technical Research & Approach Specification

## 1. Objective

Extract Person, Organization, Location, Equipment, and Event entities from OSINT source text (tweets, Telegram messages, RSS articles, ACLED data) and populate the knowledge graph. The pipeline must handle informal, short text (tweets are 280 chars with hashtags, emojis, abbreviations) while also processing longer-form content (ISW assessments, RSS articles).

**Success criteria:**
- Extract Person, Organization, Location, Equipment entities with >70% precision on OSINT tweet text
- Handle domain-specific entities that generic NER cannot recognize (military equipment, armed groups, conflict zones)
- Never block report ingestion on NER failure (best-effort)
- Operate without mandatory external API dependencies
- Support per-connector configuration (on/off, entity types, thresholds)

## 2. Approaches Overview

Four distinct architectural approaches were evaluated:

```
┌─────────────────────────────────────────────────────────────────┐
│  Approach 1: Pure NER Libraries (current)                       │
│  Text → compromise → Person/Org/Location + Gazetteer → Equipment│
├─────────────────────────────────────────────────────────────────┤
│  Approach 2: LLM-based Extraction                               │
│  Text → LLM (OpenAI/Anthropic/Ollama) → All entity types        │
├─────────────────────────────────────────────────────────────────┤
│  Approach 3: Local ML Models (Transformers.js)                  │
│  Text → Transformers.js (BERT/XLM-RoBERTa) → Token-level NER    │
├─────────────────────────────────────────────────────────────────┤
│  Approach 4: Hybrid NER + LLM (Recommended)                    │
│  Text → Library (fast/pre-filter) → LLM (refine/classify) → All │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Approach 1: Pure NER Libraries

### 3.1 compromise (current implementation)

| Dimension | Assessment |
|-----------|-----------|
| **Size** | ~200KB minified |
| **Speed** | ~1MB text/sec, ~0.1ms per tweet |
| **Entity types** | .people(), .organizations(), .places() |
| **Accuracy** | **Low on tweets.** Heuristic-based (14K word lexicon). Misses informal names, handles, abbreviations |
| **Confidence** | None native. Computed synthetically (length, word count) |
| **Dependencies** | Zero. Pure JS |
| **Cost** | Free. No network calls |

**Live test performance (15 tweets):**
- 46 entities extracted / 15 tweets
- Known issues: "President" extracted alone (title without name), possessives on names ("Kellie Meyer's"), no Equipment detection (requires gazetteer)
- Precision on OSINT text: ~55-65% (based on sample)

### 3.2 wink-nlp + wink-eng-lite-web-model

| Dimension | Assessment |
|-----------|-----------|
| **Size** | ~10KB (core) + ~1MB (model) |
| **Speed** | ~650K tokens/sec |
| **Entity types** | **None in lite model.** entities() returns only DATE/EMOJI. No PER/ORG/LOC |
| **Accuracy** | N/A for NER. POS tagging: ~95% |

**Verdict: Rejected.** The lite web model has no NER classification. The full model (`wink-eng-lite-model`) does not exist as a separate npm package. Would require custom model training.

### 3.3 NLP.js (@nlpjs/ner)

| Dimension | Assessment |
|-----------|-----------|
| **Size** | ~50MB (full install, multi-language) |
| **Speed** | Moderate. Neural network inference |
| **Entity types** | Configurable enum + regex + trim entities. Built-in Duckling integration, Microsoft Recognizers |
| **Accuracy** | **Configurable.** Rule-based + neural. Can train custom entities. Supports fuzzy matching |
| **Confidence** | Yes. Built-in accuracy scores |
| **Dependencies** | Many. 40+ language packages. Heavy install |
| **Cost** | Free. No network calls |

**Key feature:** NLP.js supports training custom NER models with regex + enum + utterance-based entities. You define: `{ entity: 'equipment', options: { T90M: ['T-90M', 'T90', 'T-90M Proryv'] } }` and it handles fuzzy matching. This replaces the need for our custom YAML gazetteer approach.

### 3.4 Transformers.js (@huggingface/transformers)

| Dimension | Assessment |
|-----------|-----------|
| **Size** | ~20-500MB per model (downloaded once, cached) |
| **Speed** | Slower. BERT-base: ~50-100 tweets/sec on CPU |
| **Entity types** | Full token classification (PER/ORG/LOC/MISC via CoNLL-03 models) |
| **Accuracy** | **High.** BERT-based NER models achieve 90-93% F1 on CoNLL-03. Xenova/bert-base-NER achieves 91% |
| **Confidence** | Yes. Per-token logit scores |
| **Dependencies** | ONNX Runtime WASM. First load ~2-5s for model download |
| **Cost** | Free. Models cached on disk after first download. No network calls on subsequent runs |

**Key models available:**
- `Xenova/bert-base-NER` — CoNLL-03 trained, PER/ORG/LOC/MISC, ~110MB
- `Xenova/bert-large-NER` — Higher accuracy, ~340MB
- `Xenova/distilbert-base-uncased-finetuned-conll03-english` — Faster, smaller, ~70MB

**Example:**
```typescript
import { pipeline } from '@huggingface/transformers';
const ner = await pipeline('token-classification', 'Xenova/bert-base-NER');
const entities = await ner('Russian T-90M tanks near Bakhmut');
// [{entity: 'B-LOC', word: 'Russian', score: 0.99}, {word: 'T-90M', entity: 'B-MISC'}, ...]
```

**Challenges:**
- "T-90M" is classified as MISC not Equipment (no military equipment class in CoNLL-03)
- Models are general-purpose English — not fine-tuned on OSINT/military text
- ONNX Runtime WASM is Node.js-only (no native deps, uses WASM)
- Cold start: 2-5s to download 110MB model on first run

### 3.5 Library Comparison Matrix

| Library | Size | Speed | Accuracy | PER/ORG/LOC | Equipment | Confidence | Dependencies | Cost |
|---------|------|-------|----------|-------------|-----------|------------|--------------|------|
| **compromise** | 200KB | ★★★★★ | ★★☆☆☆ | Partial | No | Synthetic | 0 | Free |
| **wink-nlp lite** | 1MB | ★★★★★ | N/A | No | No | N/A | 0 | Free |
| **NLP.js** | 50MB | ★★★☆☆ | ★★★★☆ | Yes (trainable) | Yes (enum) | Built-in | Many | Free |
| **Transformers.js** | 70-340MB | ★★☆☆☆ | ★★★★★ | Yes | No (MISC) | Per-token | ONNX WASM | Free |
| **Our Gazetteer** | ~5KB | ★★★★★ | ★★★★★ | No | Yes | 1.0 (exact) | yaml | Free |

---

## 4. Approach 2: LLM-based Entity Extraction

### 4.1 OpenAI / Anthropic API

| Dimension | Assessment |
|-----------|-----------|
| **Entity types** | All. Prompt-defined. Can extract any ontology type |
| **Accuracy** | **Very high.** GPT-4/Claude 4 achieve 90-98% on NER tasks with proper prompting |
| **Cost** | OpenAI GPT-4o-mini: ~$0.15/1M input tokens, ~$0.60/1M output. ~$1-3/day for ~5000 tweets |
| **Latency** | 200-800ms per API call (network round trip) |
| **Rate limit** | Variable. Requires queue + retry |
| **External dep** | Yes. Requires API key + internet |

**Key advantage:** LLMs can extract entities AND classify them into domain-specific ontology types (e.g., "Armed Group" vs "Government Agency", "MAIN_BATTLE_TANK" vs "DRONE"). They understand context — "Russia" in "Russian forces" → Organization(MILITARY_UNIT) vs "Russia" in "visited Russia" → Location.

**Prompt design for structured extraction:**
```
Extract entities from this OSINT report and classify them:
- Person: individual names
- Organization: military units, government agencies, armed groups
- Location: cities, regions, countries, facilities  
- Equipment: military hardware with specific category

Report: "Russian T-90M tanks from 4th Guards Tank Division spotted near Bakhmut"
Response: JSON structured output
```

**Challenges:**
- Cost scales with volume (5000 tweets/day = ~$2-5/day)
- Latency adds up in real-time pipelines
- External API dependency = single point of failure
- Rate limits may throttle high-volume ingestion
- Prompt engineering required for consistent output format

### 4.2 Local LLM (Ollama / llama.cpp)

| Dimension | Assessment |
|-----------|-----------|
| **Models** | Llama 3.2 (3B), Mistral 7B, Gemma 2 (2B-9B), Phi-3 (3.8B) |
| **Size** | 2-8GB RAM required. GPU recommended for speed |
| **Speed** | 10-100 tokens/sec on CPU (Apple Silicon: 30-80 t/s) |
| **Accuracy** | Good. Llama 3.2 3B matches GPT-3.5 on NER tasks |
| **Cost** | Free. No API keys. Local compute |
| **External dep** | Ollama must be running as a service |

**Key advantage:** No API costs, no rate limits, full control. Can run quantized models (Q4_K_M) on CPU with acceptable speed.

**Challenges:**
- Requires separate Ollama service (Docker container or local binary)
- 2-8GB RAM overhead
- Slower than API-based LLMs on CPU
- Model must be pulled/managed (versioning, updates)

---

## 5. Approach 3: Hybrid NER + LLM

This is the most promising approach. It combines the speed and zero-cost of NER libraries with the accuracy and domain understanding of LLMs.

### 5.1 Architecture: Two-Tier Pipeline

```
                    ┌─────────────────────┐
                    │   IntelReport Text   │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   Tier 1: Library    │
                    │  (fast, free, local) │
                    │                      │
                    │  • Transformers.js    │
                    │    BERT-base-NER     │
                    │  • Equipment Gazetteer│
                    │  • Custom Regex Rules │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   Tier 2: LLM        │
                    │  (accurate, optional) │
                    │                      │
                    │  • Refine library NER │
                    │  • Classify ambiguous│
                    │  • Extract novel types│
                    │  • Validate confidence│
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Entity Resolution   │
                    │  (dedup, link, store)│
                    └─────────────────────┘
```

### 5.2 Tier 1 Strategies

**Option A: Transformers.js BERT-NER + Gazetteer (Recommended)**
- BERT-base-NER for PER/ORG/LOC/MISC
- 70-110MB model, downloaded once, cached on disk
- 91% F1 on standard NER, 70-80% on tweet text
- Equipment via YAML gazetteer (80 entries, regex word-boundary matching)
- Fast: 50-100 tweets/sec on CPU
- Zero network calls after first model download

**Option B: compromise + Gazetteer (Current)**
- Works but low accuracy on tweet text (~55-65%)
- Already implemented, tested, working
- Minimal footprint

### 5.3 Tier 2: LLM Refinement (Optional, Configurable)

The LLM tier serves three purposes:

1. **Re-classify MISC tokens:** BERT-NER classifies "T-90M" as MISC. LLM re-classifies to Equipment:MAIN_BATTLE_TANK
2. **Disambiguate context:** "Russia" could be Org or Location — LLM resolves from context
3. **Extract novel types:** Event names, Narratives, Indicators that libraries cannot detect

**LLM invocation strategy:**
- **Default: OFF.** Tier 1 only.
- **Per-connector toggle:** `entityExtraction.llm.enabled: true` in YAML config
- **LLM provider configurable:** OpenAI, Anthropic, Ollama (local), or custom endpoint
- **Batch mode:** Collect MISC/low-confidence entities and send batch to LLM every N tweets
- **Cost optimization:** Only send to LLM when Tier 1 confidence < threshold

**LLM provider comparison:**

| Provider | Cost/tweet | Latency | Quality | Setup | Offline |
|----------|-----------|---------|---------|-------|---------|
| **OpenAI GPT-4o-mini** | ~$0.0001 | 300ms | ★★★★★ | API key | No |
| **Anthropic Claude Haiku** | ~$0.00025 | 400ms | ★★★★★ | API key | No |
| **Ollama Llama 3.2 3B** | Free | 500-2000ms | ★★★★☆ | Docker | Yes |
| **Ollama Gemma 2 2B** | Free | 300-1500ms | ★★★★☆ | Docker | Yes |

### 5.4 Fallback Chain

```
Try Tier 1 (BERT-NER)
  ├─ Confidence ≥ 0.8 → Accept immediately
  ├─ Confidence 0.5-0.8 → Mark for LLM review (if enabled)
  └─ Confidence < 0.5 → Discard (false positive likely)

If Tier 1 fails (model not loaded):
  └─ Fall back to compromise (current implementation)

If LLM enabled and Tier 1 has low-confidence entities:
  ├─ Queue for batch LLM processing
  ├─ LLM unavailable → Use Tier 1 results as-is
  └─ LLM error → Use Tier 1 results as-is (never block)
```

---

## 6. Approach 4: Specialized Domain Models

### 6.1 Fine-tuned BERT on OSINT/Military Text

Could fine-tune a BERT-NER model on a labeled dataset of OSINT tweets with military entity types. This would give:
- PER/ORG/LOC/GPE recognition optimized for tweet text
- Custom entity types: EQUIPMENT, ARMED_GROUP, CONFLICT_ZONE, WEAPON_SYSTEM

**Requirements:**
- Labeled dataset: 500-2000 annotated tweets (manual or LLM-assisted labeling)
- Fine-tuning infrastructure: Python + Hugging Face Transformers + GPU
- Convert to ONNX → use in Transformers.js

**Effort:** 1-2 weeks for dataset creation + 1 day for training
**Value:** Very high if OSINT processing scales to 10K+ tweets/day

### 6.2 Custom compromise Plugin

compromise supports `.extend()` with custom tags and word lists. Could enhance it with:
- Military unit names (4th Guards Tank Division, Wagner Group, etc.)
- Known person names (Zelensky, Putin, Shoigu, etc.)
- Conflict zone names (Donbas, Kursk, etc.)

**Effort:** 1-2 days
**Value:** Moderate. Improves compromise accuracy but still rule-based.

---

## 7. Comprehensive Comparison

| Approach | Accuracy | Speed | Cost | Complexity | Offline | Domain Entities |
|----------|----------|-------|------|------------|---------|-----------------|
| compromise + Gazetteer (current) | ★★☆☆☆ | ★★★★★ | Free | Low | Yes | Equipment (gazetteer) |
| Transformers.js BERT-NER | ★★★★☆ | ★★★☆☆ | Free | Medium | Yes* | No (MISC bucket) |
| Transformers.js + Gazetteer | ★★★★☆ | ★★★☆☆ | Free | Medium | Yes* | Equipment (gazetteer) |
| OpenAI/Anthropic API | ★★★★★ | ★★☆☆☆ | $ | Low | No | All (prompt-defined) |
| Ollama local LLM | ★★★★☆ | ★★☆☆☆ | Free | High | Yes | All (prompt-defined) |
| **Hybrid: TF.js + LLM (Recommended)** | ★★★★★ | ★★★☆☆ | $-Free | Medium-High | Configurable | All |

*After first model download

---

## 8. Recommended Architecture

### Tier 1: Transformers.js BERT-NER + Equipment Gazetteer (Primary)

```
Text → BERT-base-NER (token classification)
     → Map B-PER/I-PER → Person
       B-ORG/I-ORG → Organization  
       B-LOC/I-LOC → Location
       B-MISC/I-MISC → Hold for LLM refinement (if enabled)
     → Equipment Gazetteer (YAML, regex)
     → Merge + deduplicate
```

**Model:** `Xenova/bert-base-NER` (110MB, first download 2-5s, cached)
**Fallback:** compromise (if BERT model fails to load)
**Coverage:** PER/ORG/LOC with 70-80% accuracy on tweets, Equipment with 100% (gazetteer)

### Tier 2: LLM Refinement (Optional, Configurable)

```
Low-confidence entities + MISC tokens
     → LLM prompt with context
     → Refine classification
     → Extract additional entity types
```

**Default:** OFF. Enable per-connector in YAML config.
**Provider:** OpenAI GPT-4o-mini (default, cheapest) or Ollama (local, free)

### Implementation Plan

**Phase 1 — Transformers.js Upgrade (replace compromise)**
- Replace WinkExtractor's compromise backend with Transformers.js BERT-NER
- Keep the same EntityExtractor interface — no pipeline changes needed
- Add model caching and lazy loading
- Fall back to compromise if model fails to load
- Estimated: 1 day

**Phase 2 — LLM Refinement Tier (optional)**
- Add LLM configuration to EntityExtractionConfig YAML
- Implement batched LLM refinement for low-confidence entities
- Support OpenAI, Anthropic, Ollama providers
- Implement cost tracking and rate limiting
- Estimated: 1-2 days

**Phase 3 — Custom compromise Plugin (complementary)**
- Extend compromise lexicon with OSINT-specific terms
- Add military unit names, known persons, conflict zones
- This helps both Tier 1 and as a fast pre-filter
- Estimated: 1-2 days

**Phase 4 — Fine-tuned Domain Model (future)**
- Label 500-2000 OSINT tweets with domain entity types
- Fine-tune BERT-NER for military/OSINT domain
- Deploy as Transformers.js ONNX model
- Estimated: 1-2 weeks

---

## 9. Configuration Design

### YAML Schema (EntityExtractionConfig)

```yaml
entityExtraction:
  enabled: true
  types:
    - Person
    - Organization
    - Location
    - Equipment
  minConfidence: 0.6
  maxEntitiesPerReport: 20
  minTextLength: 30

  # Tier 1: NER library configuration
  library:
    provider: transformers.js   # transformers.js | compromise | nlpjs
    model: Xenova/bert-base-NER # model for token classification
    fallback: compromise        # fallback if model unavailable

  # Tier 2: LLM refinement (optional)
  llm:
    enabled: false              # default off
    provider: openai            # openai | anthropic | ollama | custom
    model: gpt-4o-mini         # model name
    apiKey: ${OPENAI_API_KEY}  # env var reference
    endpoint: null              # custom endpoint for self-hosted
    minConfidence: 0.5         # only refine if Tier 1 confidence < this
    maxTokens: 500
    batchSize: 10              # batch N low-confidence entities per call
    maxDailyCost: 5.0          # cost cap in USD

  # Equipment Gazetteer
  gazetteer:
    enabled: true
    path: domain-packs/osint/entity-extraction/equipment-gazetteer.yaml
```

---

## 10. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| BERT-NER model fails to load (network, disk) | Low | Medium | Fall back to compromise. Pipeline continues. |
| BERT-NER slow on CPU for high volume | Medium | Low | Process tweets in batches. 100 tweets/sec is ample for 5 tweets/sec current rate. |
| LLM cost exceeds budget | Low | Low | Daily cost cap. Default OFF. Only for refinement. |
| LLM API outage | Low | Low | Fall back to Tier 1 results. Pipeline never blocks. |
| BERT-NER misclassifies equipment (MISC) | High | Medium | LLM refinement (Tier 2) re-classifies MISC. Gazetteer catches known equipment. |
| Cold start model download (110MB) | One-time | Low | Download at server boot. Docker layer caching. |
| Ollama not running (local LLM) | Medium | Medium | Health check at startup. Fall back to API or Tier-1-only mode. |

## 11. Decision Matrix

```
                                    Accuracy  Cost   Speed   Offline  Complexity
compromise + Gazetteer (current)    ★★☆☆☆     Free   ★★★★★   Yes      ★☆☆☆☆
Transformers.js + Gazetteer         ★★★★☆     Free   ★★★☆☆   Yes*     ★★☆☆☆
+ LLM Refinement (OpenAI)           ★★★★★     $$     ★★★☆☆   No       ★★★☆☆
+ LLM Refinement (Ollama)           ★★★★★     Free   ★★★☆☆   Yes      ★★★★☆
```

**Recommendation:** Implement **Transformers.js BERT-NER + Equipment Gazetteer** as the new Tier 1 (replacing compromise), with **optional LLM refinement** via Ollama (local, free) or OpenAI (cloud, paid) as Tier 2. This gives the best accuracy/cost/speed balance and is configurable per deployment.

---

## 12. Open Questions

- [ ] Is ~110MB model download at boot acceptable for the Docker deployment?
- [ ] Prefer local LLM (Ollama/Docker, free, more complex) or cloud LLM (OpenAI, paid, simpler)?
- [ ] Should we add Docker Compose service for Ollama in deploy/?
- [ ] What is the budget for LLM API costs if cloud option chosen?
- [ ] Worth investing in a fine-tuned OSINT NER model in Phase 4?

## Sources

- [Source: ner-entity-extraction-plan.md]
- [Source: adr-011-ner-compromise-over-wink.md]
- [Source: https://github.com/spencermountain/compromise]
- [Source: https://github.com/axa-group/nlp.js]
- [Source: https://github.com/winkjs/wink-nlp]
- [Source: https://github.com/huggingface/transformers.js]
- [Source: https://ollama.com]
- Live testing of compromise on 15 real tweets (2026-06-18)
