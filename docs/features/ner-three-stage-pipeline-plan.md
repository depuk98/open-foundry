---
title: Three-Stage NER Pipeline - Implementation Plan
created: 2026-06-18
last_updated: 2026-06-18
type: plan
status: planned
related_components:
  - ner-extraction
  - sync-engine
  - api-gateway
  - cel-evaluator
related_features:
  - osint-domain-pack
  - ner-three-stage-pipeline-spec
  - ner-python-vs-typescript-comparison
---

# Implementation Plan: Three-Stage NER Pipeline

## Overview

Build a Python gRPC sidecar service running GLiNER + Flair in parallel with phi4-mini LLM verification (via host Ollama), deploy in Docker Compose, wire into the existing changeApplier in server.ts. Follows the exact same sidecar pattern as the CEL evaluator (Go gRPC -> Python gRPC). Keep compromise + gazetteer as fallback.

## Agent / Skill / Plugin Usage During Implementation

Each task description includes the recommended skill, subagent, or tool to use. Before starting any task, scan available skills in the system prompt and load matching ones. Use subagents via the `task` tool for independent workstreams.

| Context | Skill / Agent | When |
|---------|---------------|------|
| **Python development** | `python-development-python-code-style`, `python-development-python-project-structure`, `python-development-python-testing-patterns` | All Python tasks (Tasks 1-8, 13, 15) |
| **TypeScript gRPC client** | `api-and-interface-design`, `backend-development-api-design-principles` | Tasks 10-11 |
| **Docker + deployment** | `ci-cd-and-automation`, `shipping-and-launch` | Tasks 8-9 |
| **Testing (all)** | `test-driven-development`, `python-development-python-testing-patterns`, `javascript-typescript-javascript-testing-patterns` | Tasks 13-15 |
| **Code review** | `code-review-and-quality`, `agent-teams__team-reviewer` (security, performance, architecture dims) | After each phase checkpoint |
| **Debugging** | `debugging-and-error-recovery`, `agent-teams__team-debugger` | If any task encounters unexpected errors |
| **Incremental delivery** | `incremental-implementation` | Throughout — commit after each task |
| **Observability** | `observability-and-instrumentation` | Task 7 (pipeline logging), Task 14 (metrics) |
| **Performance** | `performance-optimization` | Task 7 (parallel execution verification) |
| **Security** | `security-and-hardening` | Task 8 (Docker security), Task 12 (gRPC auth) |
| **Documentation** | `unified-agent-engine-docs`, `documentation-generation-api-reference` | After Phase 4 — component page, ADR |
| **Logging** | `unified-agent-engine-logging` | After every task/checkpoint |

### Parallelization Opportunities

These independent workstreams can run simultaneously using the `task` tool:
- **Tasks 3 + 4**: GLiNER and Flair stages — different files, same interface, no cross-dependency
- **Tasks 10 + 8**: TS gRPC client and Python Dockerfile — different languages, different packages
- **Tasks 13 + 14**: Python tests and TS tests — different frameworks, different packages

## Architecture Decisions

- **gRPC (not REST):** matches CEL evaluator pattern. @grpc/grpc-js + @grpc/proto-loader dynamic proto loading.
- **Python service:** gRPC server with GLiNER + Flair loaded at startup. Ollama called via HTTP.
- **Ollama:** external (host), not in Docker Compose. ner-service calls `host.docker.internal:11434` (Mac) or configurable `OLLAMA_HOST` env var (Linux).
- **Conflict-only LLM:** phi4-mini invoked only when Stage 2 detects conflicts or low-confidence entities.
- **Fallback:** compromise + gazetteer stays as `WinkExtractor` + `GazetteerExtractor` in `CompositeExtractor`. `GrpcNerExtractor` tried first.
- **Graceful startup:** gRPC health check passes once EITHER GLiNER or Flair is ready (not both). Server serves with available models while the other loads in background.
- **Observability:** Python service emits structured JSON logs with stage latencies and OpenTelemetry trace context propagation.
- **Concurrent safety:** gRPC server handles concurrent requests via grpcio thread pool. GLiNER and Flair are read-only at inference time (thread-safe).

## Dependency Graph

```
ner.proto (gRPC contract)          --- shared between Python + TS
    |
    +-- packages/ner-service/ (Python)
    |       +-- server.py            (orchestrator + gRPC handler)
    |       +-- gliner_stage.py      (GLiNER extraction)
    |       +-- flair_stage.py       (Flair extraction)
    |       +-- ensemble_merge.py    (Stage 2 merge logic)
    |       +-- llm_reviewer.py      (Stage 3 phi4-mini review)
    |       +-- config.py            (env vars, labels, thresholds)
    |       +-- logging_config.py    (structured JSON logging)
    |       +-- Dockerfile
    |       +-- requirements.txt
    |       +-- proto/ner.proto
    |       +-- tests/
    |
    +-- packages/sync/ (TypeScript)
    |       +-- entity-extraction/
    |               +-- ner-grpc-client.ts   (@grpc/grpc-js, mirrors cel/client.ts)
    |               +-- grpc-extractor.ts    (EntityExtractor impl)
    |               +-- index.ts             (exports)
    |               +-- __tests__/
    |
    +-- packages/api/
    |       +-- server.ts                    (changeApplier wiring)
    |
    +-- deploy/
            +-- docker-compose.yaml          (ner-service addition)
            +-- .env                         (NER vars)
```

## Task List

### Phase 1: Python NER Service

**Checkpoint:** Python service starts, loads models, serves gRPC, extracts entities via both GLiNER and Flair.

**Skills to load:** `python-development-python-code-style`, `python-development-python-project-structure`, `test-driven-development`

---

- [ ] **Task 1: Create gRPC proto contract + Python project structure**

  **Description:** Create `packages/ner-service/` with proper Python package layout. Define `proto/ner.proto` with NerService gRPC contract — ExtractEntities RPC with request (text, labels, min_confidence, max_entities, enable_llm_review) and response (entities with text/type/confidence/status/context + PipelineMetadata with stage counts and latencies). Create `__init__.py`, `config.py` (env var loading), `logging_config.py` (structured JSON logger), `requirements.txt` (grpcio, grpcio-tools, gliner, flair, torch --cpu, httpx, python-json-logger).

  **Implementation details to address:**
  - Proto response includes `PipelineMetadata` message (gliner_count, flair_count, conflicts, llm_reviewed, final_count, stage1_latency_ms, stage3_latency_ms, llm_invoked)
  - `config.py` reads from env vars with sensible defaults: `GLINER_MODEL` (gliner-community/gliner_small-v2.5), `FLAIR_MODEL` (ner-large), `OLLAMA_HOST` (host.docker.internal:11434), `OLLAMA_MODEL` (phi4-mini), `GRPC_PORT` (50052), `MIN_CONFIDENCE` (0.4), `MAX_ENTITIES` (20), `ENABLE_FLAIR` (true), `ENABLE_LLM` (true), `LOG_LEVEL` (INFO)
  - `logging_config.py` uses `python-json-logger` for structured JSON output matching pino format (level, time, msg, ...rest)
  - `requirements.txt` pins versions: `grpcio>=1.60, grpcio-tools>=1.60, gliner>=0.2, flair>=0.15, torch>=2.0 --index-url https://download.pytorch.org/whl/cpu, httpx>=0.27, python-json-logger>=2.0, pyyaml>=6.0`

  **Acceptance:**
  - proto definition compiles (no syntax errors)
  - Python package structure importable
  - `config.py` loads all env vars with defaults

  **Verification:**
  - Manual review of proto
  - `python -c "from packages.ner-service import config; print(config.GLINER_MODEL)"`

  **Dependencies:** None

  **Files:** `packages/ner-service/proto/ner.proto` (NEW), `packages/ner-service/__init__.py` (NEW), `packages/ner-service/config.py` (NEW), `packages/ner-service/logging_config.py` (NEW), `packages/ner-service/requirements.txt` (NEW)

  **Scope:** M (5 files)

  **Agent:** Use `task` with `python-development__python-pro` subagent for Python project structure setup.

---

- [ ] **Task 2: Python gRPC server skeleton with proto compilation**

  **Description:** Create `server.py` — Python gRPC server. Generate gRPC stubs from proto using `grpcio-tools`: `python -m grpc_tools.protoc -Iproto --python_out=. --grpc_python_out=. proto/ner.proto`. Implement stub `ExtractEntities` handler returning empty entities. Implement `grpc.health.v1.Health` service for Docker health probe. Serve on `GRPC_PORT`. Include graceful shutdown.

  **Implementation details to address:**
  - Proto compilation: add script `compile_proto.sh` or Makefile target. Generated files (`ner_pb2.py`, `ner_pb2_grpc.py`) are gitignored and regenerated on build.
  - Health check: implement standard `grpc.health.v1.Health/Check` RPC. Initially returns `NOT_SERVING` until at least one model is loaded.
  - Thread pool: `grpc.server(futures.ThreadPoolExecutor(max_workers=10))` for concurrent request handling.
  - Startup: server binds to `[::]:{GRPC_PORT}` (IPv4+IPv6).

  **Acceptance:**
  - `python server.py` starts and binds to port 50052
  - `grpc-health-probe -addr=localhost:50052` eventually returns healthy (after model loading in later tasks)
  - Proto stubs generate without errors
  - Health check moves from NOT_SERVING -> SERVING after model load

  **Verification:**
  - Run server, verify it starts
  - `grpc-health-probe -addr=localhost:50052` (accept initial NOT_SERVING)

  **Dependencies:** Task 1

  **Files:** `packages/ner-service/server.py` (NEW), `packages/ner-service/compile_proto.sh` (NEW), `.gitignore` update for generated pb2 files

  **Scope:** M (3 files)

  **Agent:** Use `task` with `api-scaffolding__fastapi-pro` subagent for gRPC server pattern (adapt to pure grpcio).

---

- [ ] **Task 3: GLiNER stage integration**

  **Description:** Load GLiNER model at server startup in background thread. Implement `gliner_stage.py` with `extract_gliner(text, labels, min_confidence)` — calls `model.predict_entities()`. Map output to internal entity dicts. Model: `gliner-community/gliner_small-v2.5` (~300MB, first download cached by HuggingFace Hub). Thread-safe (read-only inference).

  **Implementation details to address:**
  - Model caching: HuggingFace Hub caches in `~/.cache/huggingface/`. Mount as Docker volume.
  - ONNX export: if `config.ONNX_MODE` is set, convert model to ONNX for faster CPU inference using `convert_to_onnx.py` from GLiNER repo.
  - Startup: model loads in background thread. Health check flips to SERVING once GLiNER is loaded (even if Flair is still loading — see Task 7).
  - Error handling: if model download fails (network), retry 3x with exponential backoff. If all retries fail, set `gliner_available = False` and log error.

  **Acceptance:**
  - GLiNER model loads at startup
  - `extract_gliner(text, labels)` returns typed entities with confidence scores
  - Errors handled (never crash server)

  **Verification:**
  - Python REPL test: `from gliner_stage import extract_gliner; extract_gliner("Russian T-90M tanks near Bakhmut", ["Equipment","Location"], 0.4)`
  - Entity "T-90M" typed as Equipment, "Bakhmut" as Location

  **Dependencies:** Task 2

  **Files:** `packages/ner-service/gliner_stage.py` (NEW), `packages/ner-service/server.py` (MODIFY — import and wire)

  **Scope:** M (2 files)

  **Agent:** Use `task` with `python-development__python-pro` subagent. Load `test-driven-development` skill.

---

- [ ] **Task 4: Flair stage integration**

  **Description:** Load Flair `ner-large` model at startup in background thread. Implement `flair_stage.py` with `extract_flair(text)` — creates `Sentence`, runs `tagger.predict()`, maps PER/ORG/LOC/MISC to internal entity dicts. Map tags: PER=Person, ORG=Organization, LOC=Location, MISC=Miscellaneous. ~500MB model.

  **Implementation details to address:**
  - Model caching: Flair caches in `~/.flair/`. Mount as Docker volume.
  - Thread safety: Flair's `Classifier.predict()` is not thread-safe out of the box (some versions). Wrap each call in a lock or use per-request model copies if needed. Test with concurrent requests.
  - Startup: same pattern as GLiNER — background thread, health check independent.
  - If Flair fails to load, set `flair_available = False`, log error, server continues with GLiNER-only.
  - Long startup (~2 min for model download + load). Server serves GLiNER-only until Flair is ready.

  **Acceptance:**
  - Flair model loads at startup
  - `extract_flair(text)` returns PER/ORG/LOC/MISC entities with scores
  - Thread-safe under concurrent gRPC requests

  **Verification:**
  - Python test: `from flair_stage import extract_flair; extract_flair("Putin met NATO in Brussels")`
  - "Putin" -> PER, "NATO" -> ORG, "Brussels" -> LOC

  **Dependencies:** Task 2 (NOT Task 3 — can run in parallel)

  **Files:** `packages/ner-service/flair_stage.py` (NEW), `packages/ner-service/server.py` (MODIFY)

  **Scope:** M (2 files)

  **Agent:** `task` with parallel subagent alongside Task 3. Use `agent-teams__team-implementer`.

---

### Checkpoint 1: Phase 1 Complete

- [ ] Python server starts with both models loaded
- [ ] gRPC ExtractEntities returns entities from both GLiNER and Flair
- [ ] Health check responds SERVING once at least one model is ready
- [ ] Both models handle errors without crashing server
- [ ] Use `code-review-and-quality` skill + `agent-teams__team-reviewer` for Phase 1 code review

---

### Phase 2: Ensemble Merge + LLM Reviewer

**Checkpoint:** Stage 2 merge works, Stage 3 LLM reviewer works on conflicts.

**Skills to load:** `test-driven-development`, `api-and-interface-design`

---

- [ ] **Task 5: Implement Stage 2 ensemble merge logic**

  **Description:** Create `ensemble_merge.py`. Merge GLiNER and Flair outputs using confidence-weighted union with conflict detection. Implement type mapping table (GLiNER label + Flair tag -> resolved type). Apply conflict resolution rules from spec. Tag entities with status: CONFIRMED, SINGLE_SOURCE, GLINER_ENRICHED, CONFLICT. Handle edge cases: missing Flair output (Flair not loaded yet), missing GLiNER output.

  **Implementation details to address:**
  - Type mapping table as a dataclass/dict with explicit GLiNER label + Flair tag -> resolved type mappings
  - Span normalization: normalize text spans from both models for comparison (strip whitespace, lowercase for matching)
  - Edge case: if Flair is not yet loaded, all entities are SINGLE_SOURCE from GLiNER
  - Edge case: if GLiNER is not yet loaded, all entities are SINGLE_SOURCE from Flair with MISC mapped to generic types
  - Runs in < 1ms (pure Python dict operations, no ML)

  **Acceptance:**
  - Both-agree entities merged as CONFIRMED with max confidence
  - Flair MISC + GLiNER specific type -> GLINER_ENRICHED
  - Same span different types -> CONFLICT status
  - Both < 0.5 -> discarded
  - Missing model handled gracefully

  **Verification:**
  - pytest: provide mock GLiNER + Flair outputs, verify all 5 merge scenarios
  - pytest: test edge cases (missing Flair, missing GLiNER, both missing)

  **Dependencies:** Task 3, Task 4

  **Files:** `packages/ner-service/ensemble_merge.py` (NEW), `packages/ner-service/tests/test_ensemble_merge.py` (NEW — TDD: write test first)

  **Scope:** M (2 files)

  **Agent:** Use `test-driven-development` skill. Write tests first, then implement.

---

- [ ] **Task 6: Implement Stage 3 LLM reviewer (phi4-mini via Ollama)**

  **Description:** Create `llm_reviewer.py`. Call host Ollama (`OLLAMA_HOST`) with phi4-mini to verify conflicted entities. Send candidate entity list + original text + system prompt. Parse JSON response. Map LLM actions: confirm (keep), correct (update span/type), reject (remove), add (append). Graceful degradation: skip if no conflicts, fall back to Stage 2 output on failure, timeout at 3s.

  **Implementation details to address:**
  - Ollama API: POST `{OLLAMA_HOST}/api/chat` with model, messages, format="json", stream=false
  - Prompt template: embed original text + formatted candidate list + strict JSON output instructions
  - JSON parsing: use `json.loads()` with try/except. If malformed, try extracting JSON from markdown code blocks with regex. If still fails, use Stage 2 output.
  - Timeout: `httpx.AsyncClient(timeout=3.0)` — if Ollama takes > 3s, skip Stage 3
  - Host connectivity: `OLLAMA_HOST` env var with Mac default. For Docker on Linux, user sets to actual host IP.
  - Logging: log LLM latency, token counts if available, whether LLM was invoked or skipped

  **Acceptance:**
  - LLM invoked only when Stage 2 has CONFLICT or low-confidence SINGLE_SOURCE entities
  - phi4-mini response parsed correctly
  - confirm/correct/reject/add actions applied
  - Timeout/error -> Stage 2 output returned unchanged

  **Verification:**
  - pytest with mock httpx response (valid JSON)
  - pytest with mock httpx response (malformed JSON -> fallback)
  - pytest with mock httpx response (timeout -> fallback)
  - pytest with no conflicts -> LLM skipped entirely
  - Integration test: real Ollama call with test conflict scenario

  **Dependencies:** Task 5

  **Files:** `packages/ner-service/llm_reviewer.py` (NEW), `packages/ner-service/tests/test_llm_reviewer.py` (NEW)

  **Scope:** M (2 files)

  **Agent:** Use `test-driven-development` skill. Load `observability-and-instrumentation` skill for logging.

---

- [ ] **Task 7: Wire full pipeline + observability**

  **Description:** Connect all three stages in server.py's ExtractEntities handler. Flow: Stage 1 (GLiNER + Flair parallel via `asyncio.gather` or thread pool) -> Stage 2 (ensemble_merge) -> Stage 3 (llm_reviewer, only if conflicts AND enable_llm_review=true). Return final entities with PipelineMetadata (stage counts, per-stage latencies, llm_invoked flag). Add structured logging at each stage with per-request trace IDs.

  **Implementation details to address:**
  - Parallel execution: use `concurrent.futures.ThreadPoolExecutor` for GLiNER and Flair (their predict methods are sync). `asyncio.get_event_loop().run_in_executor()` to not block gRPC thread.
  - Logging: each stage logs `{stage, latency_ms, entity_count, trace_id, text_length}` as structured JSON
  - Trace propagation: extract `traceparent` from gRPC metadata if present, add to log context
  - Metrics: counters for `ner_requests_total`, `ner_stage1_latency`, `ner_stage3_latency`, `ner_entities_extracted`, `ner_llm_invoked`, `ner_errors`
  - Health check: moves to SERVING once at least one model (GLiNER or Flair) is loaded. Both models are optional — server works with either or both.
  - Graceful degradation matrix:
    - Both models loaded: full 3-stage pipeline
    - Only GLiNER: Stage 1 = GLiNER only, Stage 2 = pass-through, Stage 3 = LLM still works
    - Only Flair: Stage 1 = Flair only, Stage 2 = pass-through, Stage 3 = LLM still works
    - Neither loaded: gRPC returns UNAVAILABLE, health = NOT_SERVING
    - LLM unreachable: skip Stage 3, Stage 2 output returned

  **Acceptance:**
  - Full pipeline executes end-to-end
  - Stage 1 runs GLiNER + Flair concurrently
  - Stage 3 conditionally runs (conflicts + enable flag)
  - Metadata includes accurate stage counts and latencies
  - Graceful degradation verified for all scenarios
  - Structured logs emitted at each stage

  **Verification:**
  - Send gRPC request -> trace through logs for three stages
  - Stop Ollama -> verify Stage 3 skipped, Stage 2 output returned
  - Verify with real tweets from our test set
  - Measure total latency (< 200ms for conflict-free, < 500ms with LLM)

  **Dependencies:** Task 5, Task 6

  **Files:** `packages/ner-service/server.py` (MODIFY)

  **Scope:** S (1 file)

  **Agent:** Load `observability-and-instrumentation`, `performance-optimization` skills.

---

### Checkpoint 2: Phase 2 Complete

- [ ] Full 3-stage pipeline returns verified entities via gRPC
- [ ] Stage 3 only fires on conflicts
- [ ] All graceful degradation scenarios verified
- [ ] Structured JSON logs emitted with stage latencies
- [ ] Use `code-review-and-quality` skill for Phase 2 review

---

### Phase 3: Docker + Integration

**Checkpoint:** ner-service in Docker Compose, TS client wired, live on tweets.

**Skills to load:** `ci-cd-and-automation`, `shipping-and-launch`, `security-and-hardening`

---

- [ ] **Task 8: Create Dockerfile for ner-service**

  **Description:** Slim Dockerfile: `python:3.12-slim` base. Install system deps (grpc-health-probe binary). Copy requirements.txt and pip install (CPU-only PyTorch: `--index-url https://download.pytorch.org/whl/cpu`). Copy proto + server.py + all stage modules. Expose 50052. HEALTHCHECK via grpc-health-probe. Run as non-root user. Mount volumes for model cache.

  **Implementation details to address:**
  - grpc-health-probe: download pre-built binary from GitHub releases (`grpc-ecosystem/grpc-health-probe`), same as CEL evaluator Dockerfile. It's a Go binary but probes any gRPC service implementing health.v1.Health.
  - Non-root: create `neruser` with `adduser`, `USER neruser`.
  - Volumes: mount `/models` (HuggingFace cache) and `/root/.flair` (Flair cache) as named Docker volumes for persistence across restarts.
  - CPU-only torch: `pip install torch --index-url https://download.pytorch.org/whl/cpu` to avoid downloading CUDA bloat.
  - Layer caching: copy requirements.txt first, pip install, THEN copy source — so code changes don't reinstall deps.
  - `.dockerignore`: exclude `__pycache__`, `.pytest_cache`, `tests/`, `*.pyc`.

  **Acceptance:**
  - `docker build -t ner-service .` succeeds
  - Container starts without root
  - Models load on first boot (downloaded to volume)
  - Health check passes
  - gRPC reachable from other containers

  **Verification:**
  - `docker build` and `docker run` locally
  - `docker exec <container> grpc-health-probe -addr=:50052` returns healthy

  **Dependencies:** Task 7

  **Files:** `packages/ner-service/Dockerfile` (NEW), `packages/ner-service/.dockerignore` (NEW)

  **Scope:** M (2 files)

  **Agent:** Load `ci-cd-and-automation` and `security-and-hardening` skills.

---

- [ ] **Task 9: Add ner-service to docker-compose.yaml + env config**

  **Description:** Add `ner-service` service to `deploy/docker-compose.yaml`. Mirror cel-evaluator pattern. Build from `packages/ner-service/Dockerfile`. Environment vars. Volume mounts for model cache (`ner_models` named volume). Health check. Add to api-gateway dependency list. Add `NER_SERVICE_URL` env var to api-gateway. Handle host Ollama connectivity.

  **Implementation details to address:**
  - Docker Compose service definition mirrors cel-evaluator:
    ```yaml
    ner-service:
      build:
        context: ..
        dockerfile: packages/ner-service/Dockerfile
      ports:
        - "50052:50052"
      environment:
        - OLLAMA_HOST=${OLLAMA_HOST:-host.docker.internal:11434}
        - GLINER_MODEL=gliner-community/gliner_small-v2.5
        - FLAIR_MODEL=ner-large
        - OLLAMA_MODEL=phi4-mini
        - GRPC_PORT=50052
        - DEVICE=cpu
        - LOG_LEVEL=${LOG_LEVEL:-info}
      volumes:
        - ner_models:/models
        - ner_flair:/root/.flair
      healthcheck:
        test: ["CMD", "grpc-health-probe", "-addr=:50052"]
        interval: 10s
        timeout: 5s
        retries: 10
        start_period: 120s
      deploy:
        resources:
          limits:
            memory: 8G
    ```
  - **Ollama connectivity (CRITICAL):** On macOS Docker Desktop, `host.docker.internal` works automatically. On Linux, add `extra_hosts: ["host.docker.internal:host-gateway"]` to the ner-service definition. This uses Docker's built-in host gateway feature (Docker 20.10+).
  - Add to api-gateway env: `NER_SERVICE_URL: "ner-service:50052"` and `depends_on: ner-service: condition: service_healthy`
  - Named volumes at top level: `ner_models:` and `ner_flair:`
  - `.env` additions: `NER_SERVICE_URL=ner-service:50052`, `OLLAMA_HOST=host.docker.internal:11434`
  - start_period: 120s (Flair takes ~2 min to download + load first time, ~30s cached)

  **Acceptance:**
  - `docker compose up` starts ner-service
  - ner-service healthy before api-gateway starts
  - Host Ollama reachable (verified in logs)
  - API gateway receives `NER_SERVICE_URL`

  **Verification:**
  - `docker compose up -d` -> `docker compose ps` shows ner-service (healthy)
  - `docker compose logs ner-service` shows model loading + "server ready on :50052"
  - `grpc-health-probe -addr=localhost:50052` returns healthy

  **Dependencies:** Task 8

  **Files:** `deploy/docker-compose.yaml` (MODIFY), `deploy/.env` (MODIFY)

  **Scope:** M (2 files)

  **Agent:** Load `ci-cd-and-automation` and `shipping-and-launch` skills.

---

- [ ] **Task 10: Create TypeScript gRPC client for NER**

  **Description:** Create `packages/sync/src/entity-extraction/ner-grpc-client.ts` — mirrors `packages/actions/src/cel/client.ts` pattern EXACTLY. Use `@grpc/grpc-js` + `@grpc/proto-loader`. Load proto from `../../../ner-service/proto/ner.proto`. Expose `extractEntities(request)` with retry on UNAVAILABLE/DEADLINE_EXCEEDED (3 attempts, exponential backoff). Add `@grpc/grpc-js` and `@grpc/proto-loader` to sync package.json dependencies.

  **Implementation details to address:**
  - Proto path resolution: `resolve(currentDir, '..', '..', '..', 'ner-service', 'proto', 'ner.proto')` (mirrors cel/client.ts line 130 exactly)
  - Client interface mirrors CelClient: constructor(address, options), connect(), extractEntities(), circuit breaker, retry logic
  - gRPC address: `process.env['NER_SERVICE_URL'] ?? 'localhost:50052'`
  - Retry: 3 attempts, exponential backoff (100ms, 200ms, 400ms), only on UNAVAILABLE and DEADLINE_EXCEEDED
  - Timeout: 5s deadline per call
  - TS types: define `ProtoExtractRequest`, `ProtoExtractResponse`, `ProtoEntity`, `ProtoPipelineMetadata` interfaces matching proto
  - Add deps: `pnpm add @grpc/grpc-js @grpc/proto-loader --filter @openfoundry/sync`

  **Acceptance:**
  - Proto loaded dynamically
  - Client connects to Python service
  - extractEntities returns typed response
  - Retry on transient failures

  **Verification:**
  - Unit test with mock gRPC server (mirror cel/client.test.ts pattern)
  - Integration: call against running Python ner-service

  **Dependencies:** Task 1

  **Files:** `packages/sync/src/entity-extraction/ner-grpc-client.ts` (NEW), `packages/sync/package.json` (MODIFY)

  **Scope:** M (2 files)

  **Agent:** Use `api-and-interface-design` skill. Read `packages/actions/src/cel/client.ts` as reference pattern. Can run in PARALLEL with Task 8.

---

- [ ] **Task 11: Create GrpcNerExtractor (EntityExtractor impl)**

  **Description:** Create `packages/sync/src/entity-extraction/grpc-extractor.ts` — implements `EntityExtractor` interface using NerGrpcClient. Maps gRPC response entities to `ExtractedEntity[]`. Applies minConfidence filter client-side (defense-in-depth — server also filters). Falls back to empty array on ANY failure (network, timeout, server error). Never throws. Export from barrel.

  **Implementation details to address:**
  - Constructor: `(client: NerGrpcClient, labels: string[], minConfidence: number)`
  - `extract(text)`: calls `client.extractEntities({text, labels, minConfidence, maxEntities: 20, enableLlmReview: true})`, maps response.entities to ExtractedEntity[]
  - Entity type mapping: gRPC entity types (Person, Organization, Location, Equipment, etc.) pass through as-is
  - Failure: catch ALL errors, log warning with trace, return `[]` (never throw — per EntityExtractor contract)
  - Export from `index.ts`

  **Acceptance:**
  - Implements EntityExtractor interface
  - `extract(text)` returns typed entities via gRPC
  - gRPC failure -> returns [] (never throws)
  - Labels configurable via constructor

  **Verification:**
  - Unit test with mock NerGrpcClient
  - Extract returns correctly typed entities
  - Mock failure -> returns []

  **Dependencies:** Task 10

  **Files:** `packages/sync/src/entity-extraction/grpc-extractor.ts` (NEW), `packages/sync/src/entity-extraction/index.ts` (MODIFY)

  **Scope:** M (2 files)

  **Agent:** Use `javascript-typescript-nodejs-backend-patterns` skill.

---

- [ ] **Task 12: Wire into server.ts changeApplier**

  **Description:** Modify `packages/api/src/server.ts` NER init section (~lines 567-607). Replace current compromise-extractor-only setup with: `GrpcNerExtractor` as primary, `WinkExtractor` as fallback, both in `CompositeExtractor`. The `EntityExtractionService` stays unchanged (uses same `EntityExtractor` interface). changeApplier NER call (~10 lines) stays unchanged. Configure labels from entityExtraction YAML config.

  **Implementation details to address:**
  - Dynamic import: `const { GrpcNerExtractor } = await import('@openfoundry/sync');`
  - gRPC address: `process.env['NER_SERVICE_URL'] ?? 'localhost:50052'`
  - Labels from config: read from `mappingConfig.entityExtraction?.types` or default to all 9 types
  - Composite: `new CompositeExtractor([grpcExtractor, winkExtractor])` — composite tries each in order, first non-empty result wins. This means gRPC runs first, compromise only if gRPC returns []
  - Logging: "NER: using gRPC extractor" vs "NER: gRPC unavailable, using compromise"
  - Remove gazetteer? Keep for now (it's free, runs only if compromise is the fallback)

  **Acceptance:**
  - NER init creates GrpcNerExtractor (primary) + WinkExtractor (fallback)
  - CompositeExtractor tries gRPC first, compromise second
  - gRPC failure -> compromise fallback -> report still stored
  - Logging indicates which extractor produced entities

  **Verification:**
  - Typecheck: `pnpm run typecheck` at api package -> clean
  - Build: `pnpm run build` at api -> succeeds
  - Test: existing sync tests still pass (no regression)
  - Manual: start ner-service, run api server, inject test tweet -> entities via gRPC

  **Dependencies:** Task 11

  **Files:** `packages/api/src/server.ts` (MODIFY)

  **Scope:** M (1 file)

  **Agent:** Use `incremental-implementation` skill. Load `security-and-hardening` for gRPC auth consideration.

---

### Checkpoint 3: Phase 3 Complete

- [ ] Docker Compose starts all services including ner-service
- [ ] Real tweets flow through: Twitter connector -> changeApplier -> gRPC NER -> entity tables
- [ ] Compromise fallback verified (stop ner-service, verify tweets still ingested)
- [ ] Entity tables (person, organization, location, equipment) populate from real tweets
- [ ] Use `code-review-and-quality` + `agent-teams__team-reviewer` for full Phase 3 review

---

### Phase 4: Tests + Polish

**Checkpoint:** All tests pass, documentation updated, ready for production.

**Skills to load:** `test-driven-development`, `python-development-python-testing-patterns`, `javascript-typescript-javascript-testing-patterns`

---

- [ ] **Task 13: Python unit tests (pytest)**

  **Description:** pytest tests for `ensemble_merge.py` and `llm_reviewer.py`. Test all merge scenarios. Test LLM reviewer with mocked httpx responses. Test edge cases. Add `pytest` to requirements.txt.

  **Implementation details to address:**
  - `tests/conftest.py`: shared fixtures (sample GLiNER entities, Flair entities, combined)
  - `tests/test_ensemble_merge.py`: test all 5 merge scenarios, edge cases (empty inputs, missing model, overlapping spans)
  - `tests/test_llm_reviewer.py`: test valid JSON, malformed JSON, timeout, no conflicts, all-confirmed, mixed actions, unreachable host
  - Run: `cd packages/ner-service && python -m pytest tests/ -v`
  - Cover all degradation scenarios from Task 7

  **Acceptance:**
  - Merge tests cover both-agree, single-source, conflict, gliner-enriched, discard
  - LLM tests cover valid/malformed/timeout/skip scenarios
  - All tests pass

  **Verification:**
  - `python -m pytest tests/ -v` -> all green

  **Dependencies:** Task 5, Task 6

  **Files:** `packages/ner-service/tests/__init__.py` (NEW), `packages/ner-service/tests/conftest.py` (NEW), `packages/ner-service/tests/test_ensemble_merge.py` (NEW), `packages/ner-service/tests/test_llm_reviewer.py` (NEW), `packages/ner-service/requirements.txt` (MODIFY — add pytest)

  **Scope:** M (5 files)

  **Agent:** Use `test-driven-development` skill + `python-development-python-testing-patterns` skill. Can run in PARALLEL with Task 14.

---

- [ ] **Task 14: TypeScript unit tests (vitest)**

  **Description:** vitest tests for `ner-grpc-client.ts` and `grpc-extractor.ts`. Mock gRPC server for client tests (mirror `cel/client.test.ts`). Mock gRPC client for extractor tests. Verify entity mapping, error handling, retry logic, label propagation.

  **Implementation details to address:**
  - `ner-grpc-client.test.ts`: mock gRPC server with `@grpc/grpc-js` Server. Test successful response, server error, timeout, retry exhaustion, proto loading.
  - `grpc-extractor.test.ts`: mock NerGrpcClient. Test: successful extraction returns entities, gRPC failure returns [], entity mapping (9 types), label passing.
  - Run: `pnpm run test` at sync package

  **Acceptance:**
  - Client test: server returns entities -> client parses correctly
  - Client test: server unavailable -> retries, then errors
  - Extractor test: gRPC success -> ExtractedEntity[] with 9 types
  - Extractor test: gRPC failure -> [] (never throws)
  - All existing tests still pass (no regression)

  **Verification:**
  - `pnpm run test` at sync -> all green (including existing 193 tests)

  **Dependencies:** Task 10, Task 11

  **Files:** `packages/sync/src/entity-extraction/__tests__/ner-grpc-client.test.ts` (NEW), `packages/sync/src/entity-extraction/__tests__/grpc-extractor.test.ts` (NEW)

  **Scope:** M (2 files)

  **Agent:** Use `javascript-typescript-javascript-testing-patterns` skill. Can run in PARALLEL with Task 13.

---

- [ ] **Task 15: E2E integration test + documentation**

  **Description:** Create `tools/test-ner-through-grpc.py` — fetches 20 real tweets from DB, sends to gRPC ner-service, prints per-tweet entities with stage metadata (which stage produced them, conflict status, LLM invoked flag). Update project documentation: `docs/components/ner-service.md`, `docs/decisions/adr-012-ner-python-sidecar.md`, update `docs/index.md`, log to `docs/log.md`.

  **Implementation details to address:**
  - E2E script: reuse `tools/test-ner-comparison.py` DB query pattern. Use `grpcio` Python client to call ner-service. Print per-tweet: text preview, entity list with type/confidence/status, pipeline metadata (stage counts, latencies, llm_invoked)
  - ADR: document the decision to use Python sidecar + 3-stage pipeline over inline JS compromise
  - Component page: `docs/components/ner-service.md` with architecture, gRPC API, configuration, deployment
  - Index update: add `ner-service` to Components section, update page counts

  **Acceptance:**
  - E2E script runs against deployed ner-service
  - Per-tweet report includes entity type/confidence/source stage
  - Pipeline metadata visible (which stages ran, latencies)
  - Documentation complete (ADR + component page)

  **Verification:**
  - `python tools/test-ner-through-grpc.py` -> full report with 20 tweets
  - `docs/components/ner-service.md` exists and is cross-referenced

  **Dependencies:** Task 9

  **Files:** `tools/test-ner-through-grpc.py` (NEW), `docs/components/ner-service.md` (NEW), `docs/decisions/adr-012-ner-python-sidecar.md` (NEW), `docs/index.md` (MODIFY), `docs/log.md` (MODIFY)

  **Scope:** M (5 files)

  **Agent:** Use `unified-agent-engine-docs` skill for documentation. Load `documentation-generation-api-reference` for gRPC API docs.

---

### Checkpoint 4: Complete

- [ ] ALL tests pass: Python pytest (10+ tests) + TypeScript vitest (existing 193 + new tests)
- [ ] TypeScript typecheck: clean (zero errors)
- [ ] Docker Compose: full stack starts, all services healthy
- [ ] Real tweets produce verified entities through 3-stage pipeline at 85-92% precision
- [ ] Compromise fallback: stop ner-service, tweets still ingested, entities via compromise
- [ ] Documentation: component page, ADR, index updated, log complete
- [ ] Use `code-review-and-quality` + `agent-teams__team-reviewer` (all 3 dimensions: architecture, security, performance) for final review

---

## File Summary

| File | Action | Phase | Scope |
|------|--------|-------|-------|
| packages/ner-service/proto/ner.proto | NEW | P1 | S |
| packages/ner-service/__init__.py | NEW | P1 | S |
| packages/ner-service/config.py | NEW | P1 | S |
| packages/ner-service/logging_config.py | NEW | P1 | S |
| packages/ner-service/requirements.txt | NEW | P1 | S |
| packages/ner-service/server.py | NEW (builds across P1-P2) | P1/P2 | M |
| packages/ner-service/compile_proto.sh | NEW | P1 | S |
| packages/ner-service/gliner_stage.py | NEW | P1 | M |
| packages/ner-service/flair_stage.py | NEW | P1 | M |
| packages/ner-service/ensemble_merge.py | NEW | P2 | M |
| packages/ner-service/llm_reviewer.py | NEW | P2 | M |
| packages/ner-service/Dockerfile | NEW | P3 | M |
| packages/ner-service/.dockerignore | NEW | P3 | S |
| packages/ner-service/tests/ (5 files) | NEW | P4 | M |
| packages/sync/src/.../ner-grpc-client.ts | NEW | P3 | M |
| packages/sync/src/.../grpc-extractor.ts | NEW | P3 | M |
| packages/sync/src/.../index.ts | MODIFY | P3 | S |
| packages/sync/package.json | MODIFY | P3 | S |
| packages/sync/src/.../__tests__/ner-grpc-client.test.ts | NEW | P4 | M |
| packages/sync/src/.../__tests__/grpc-extractor.test.ts | NEW | P4 | M |
| packages/api/src/server.ts | MODIFY | P3 | M |
| deploy/docker-compose.yaml | MODIFY | P3 | M |
| deploy/.env | MODIFY | P3 | S |
| tools/test-ner-through-grpc.py | NEW | P4 | M |
| docs/components/ner-service.md | NEW | P4 | S |
| docs/decisions/adr-012-ner-python-sidecar.md | NEW | P4 | S |
| docs/index.md | MODIFY | P4 | S |
| docs/log.md | MODIFY | P4 | S |
| **Total: 29 files** | **21 NEW + 7 MODIFIED** | | |

## Risks and Mitigations

| Risk | Impact | Mitigation | Addressed In |
|------|--------|------------|-------------|
| phi4-mini JSON malformed | Medium | Regex extract JSON from markdown. Retry 1x. Fall back to Stage 2 output. | Task 6 |
| GLiNER download fails first boot | Medium | Retry 3x with backoff. Server starts with Flair-only. | Task 3 |
| Flair loads ~2 min | Low | Background thread. Health passes with GLiNER-only. Flair added when ready. | Task 4, Task 7 |
| Ollama unreachable from Docker | Medium | Configurable OLLAMA_HOST. Linux: extra_hosts in compose. Skip Stage 3 if unreachable. | Task 6, Task 9 |
| @grpc/grpc-js + proto-loader complexity | Low | Mirrors existing cel/client.ts pattern exactly (same imports, same patterns). | Task 10 |
| OOM with 3 models | Low | 8GB Docker limit. GLiNER small (~300MB) + Flair (~500MB) + Ollama (external, host RAM) = <2GB. | Task 9 |
| Thread safety (Flair) | Medium | Flair predict may not be thread-safe. Wrap in lock or test with concurrent requests. | Task 4 |
| Proto path changes break client | Low | Relative path same as cel/client.ts. Monorepo structure is stable. | Task 10 |

## Open Questions (Resolved)

- [x] phi4-mini already pulled on host Ollama
- [x] CPU-only, no GPU
- [x] Host Ollama (not in Docker Compose)
- [x] Conflicts-only LLM invocation
- [x] All 9 entity types from day one
- [x] Full Docker Compose integration
- [x] Compromise as fallback (never blocks ingestion)
