---
title: NER Service Restructure — Implementation Plan
created: 2026-06-20
type: feature
status: planned
related_components:
  - ner-service
related_features:
  - osint-domain-pack
  - ner-service-restructure-spec
  - ner-three-stage-pipeline-spec
related_decisions:
  - adr-012-ner-python-sidecar
---

# Implementation Plan: NER Service Restructure

## Overview

Restructure `packages/ner-service` from a flat 12-file dump into a `src/ner_service/` package layout with logical sub-packages, migrate from pip+requirements.txt to uv, and split `server.py` into lifecycle + handler. Zero behavioral changes — same gRPC API, same NER output, all 66 tests pass before and after every step.

Reference spec: [[ner-service-restructure-spec]]

## Architecture Decisions

**`src/ner_service/` layout** — follows Python community standard (src-layout). Isolates source from tests, scripts, config files. `uv run python -m ner_service.server` resolves correctly via `pyproject.toml`'s `[tool.pytest.ini_options] pythonpath`.

**Absolute imports** — `from ner_service.pipeline.gliner import GlinerStage`. No relative imports. Survives file moves without breaking.

**`server.py` split** — `server.py` for lifecycle (create grpc server, register, start, health, signals) and `handler.py` for `ExtractEntities` RPC logic. Separates gRPC plumbing from business logic.

**Merge 3→1** — `constants.py` (23 lines) + `logging_config.py` (67 lines) merged into `config.py`. Each was too small to justify its own file. The merged ~200-line config is still focused (all configuration concerns).

**Proto isolation** — Generated `ner_pb2.py` and `ner_pb2_grpc.py` moved to `src/ner_service/proto/`. Source code imports via `from ner_service.proto import ner_pb2`.

## Task List

> Maps to [[ner-service-restructure-spec]] §7 migration steps. Task numbers include spec step references.

### Phase 1: Scaffold & uv Setup (spec steps 1-4)

#### Task 1: Create directory tree and pyproject.toml

**Description:** Create `src/ner_service/` directory with all sub-package directories (`pipeline/`, `llm/`, `input/`, `utils/`, `proto/`). Create `pyproject.toml` with uv configuration listing all 8 runtime dependencies and pytest as dev dependency. Create `.gitignore` entries (NOT including `uv.lock` — it is committed for reproducibility).

**Acceptance criteria:**
- [ ] `src/ner_service/` exists with 5 sub-packages, each with `__init__.py`
- [ ] `pyproject.toml` validates: `uv sync` runs without errors
- [ ] `.gitignore` lists `.venv/`, `__pycache__/`, `*.pyc`

**Verification:**
- [ ] `uv sync` completes and creates `.venv/`
- [ ] `uv run python -c "import sys; print(sys.executable)"` prints path inside `.venv/`

**Dependencies:** None

**Files:**
- `packages/ner-service/pyproject.toml` — NEW
- `packages/ner-service/.gitignore` — MODIFY
- `packages/ner-service/src/ner_service/__init__.py` — NEW
- `packages/ner-service/src/ner_service/pipeline/__init__.py` — NEW
- `packages/ner-service/src/ner_service/llm/__init__.py` — NEW
- `packages/ner-service/src/ner_service/input/__init__.py` — NEW
- `packages/ner-service/src/ner_service/utils/__init__.py` — NEW
- `packages/ner-service/src/ner_service/proto/__init__.py` — NEW

**Estimated scope:** S (4 new dirs + pyproject.toml)

---

#### Task 2: Move and merge config files

**Description:** Move `config.py` to `src/ner_service/config.py`. Merge constants from `constants.py` and logging setup from `logging_config.py` into it. All three files become one ~200-line module. Update internal references within the merged file so `settings`, constants, and `get_logger()` all work from a single import.

**Acceptance criteria:**
- [ ] `from ner_service.config import settings, ALLOWED_LABELS, get_logger` works
- [ ] All constants from `constants.py` accessible via `ner_service.config`
- [ ] `get_logger(__name__)` produces a structured JSON logger (preserved behavior)
- [ ] All env var defaults from original `config.py` are present

**Verification:**
- [ ] Manual inspection: merged file is cohesive, no dead code

**Dependencies:** Task 1

**Files:**
- `packages/ner-service/src/ner_service/config.py` — MERGE (config + constants + logging_config)
- `packages/ner-service/config.py` — DELETE (in Task 12)
- `packages/ner-service/constants.py` — DELETE (in Task 12)
- `packages/ner-service/logging_config.py` — DELETE (in Task 12)

**Estimated scope:** M (merge 3 files → 1)

---

#### Task 3: Move source files to sub-packages (no import changes yet)

**Description:** Copy each source file to its target location under `src/ner_service/`. Files are placed but NOT yet import-fixed — this task just establishes the file layout. Original flat files remain untouched as fallback.

Mapping:
- `gliner_stage.py` → `src/ner_service/pipeline/gliner.py`
- `flair_stage.py` → `src/ner_service/pipeline/flair.py`
- `ensemble_merge.py` → `src/ner_service/pipeline/ensemble.py`
- `llm_reviewer.py` → `src/ner_service/llm/reviewer.py`
- `llm_validation.py` → `src/ner_service/llm/validation.py`
- `validation.py` → `src/ner_service/input/request.py`
- `text_utils.py` → `src/ner_service/utils/text.py`
- `ner_pb2.py` → `src/ner_service/proto/ner_pb2.py`
- `ner_pb2_grpc.py` → `src/ner_service/proto/ner_pb2_grpc.py`

**Acceptance criteria:**
- [ ] All 9 files placed in correct sub-packages
- [ ] Proto files in `proto/` only

**Verification:**
- [ ] `find src/ner_service -name "*.py" | wc -l` → 15+ files (9 moved + 6 __init__.py from Task 1)

**Dependencies:** Task 1

**Files:**
- `packages/ner-service/src/ner_service/pipeline/gliner.py` — COPY
- `packages/ner-service/src/ner_service/pipeline/flair.py` — COPY
- `packages/ner-service/src/ner_service/pipeline/ensemble.py` — COPY
- `packages/ner-service/src/ner_service/llm/reviewer.py` — COPY
- `packages/ner-service/src/ner_service/llm/validation.py` — COPY
- `packages/ner-service/src/ner_service/input/request.py` — COPY
- `packages/ner-service/src/ner_service/utils/text.py` — COPY
- `packages/ner-service/src/ner_service/proto/ner_pb2.py` — COPY
- `packages/ner-service/src/ner_service/proto/ner_pb2_grpc.py` — COPY

**Estimated scope:** S (9 cp commands, no logic changes)

---

### Checkpoint: Scaffold Complete
- [ ] `src/ner_service/` tree exists with all files placed
- [ ] `pyproject.toml` and `.gitignore` exist
- [ ] `uv sync` works
- [ ] Original flat files still intact (fallback if needed)

---

### Phase 2: Import Migration & Refactor (spec steps 5-12)

#### Task 4: Fix all imports in moved source files

**Description:** Replace flat `import x` with absolute `from ner_service.xxx import y` in every moved file. This is the highest-risk step — each file's imports must resolve correctly.

Import mapping (every flat import → new absolute import):

| Old | New |
|-----|-----|
| `import config` | `from ner_service.config import settings` (or specific symbols) |
| `import constants` | `from ner_service.config import ...` (merged into config) |
| `import logging_config` | `from ner_service.config import get_logger` |
| `import ensemble_merge` | `from ner_service.pipeline.ensemble import merge_entities` |
| `import flair_stage` | `from ner_service.pipeline.flair import FlairStage` |
| `import gliner_stage` | `from ner_service.pipeline.gliner import GlinerStage` |
| `import llm_reviewer` | `from ner_service.llm.reviewer import LlmReviewer` |
| `import llm_validation` | `from ner_service.llm.validation import validate_llm_output` |
| `import validation` | `from ner_service.input.request import validate_extract_request` |
| `import text_utils` | `from ner_service.utils.text import extract_context` |
| `import ner_pb2` | `from ner_service.proto import ner_pb2` |
| `import ner_pb2_grpc` | `from ner_service.proto import ner_pb2_grpc` |
| `from constants import FLAIR_TAG_MAP` | `from ner_service.config import FLAIR_TAG_MAP` |
| `from ensemble_merge import ...` | `from ner_service.pipeline.ensemble import ...` |

**Acceptance criteria:**
- [ ] All imports in moved files use `from ner_service.xxx` pattern
- [ ] No file uses `import constants` or `import logging_config` directly (both now in config)
- [ ] `ner_pb2_grpc.py` import of `ner_pb2` updated to `from . import ner_pb2` (relative within proto package)

**Verification:**
- [ ] `uv run python -c "from ner_service.config import settings, ALLOWED_LABELS, get_logger"` — no import errors

**Dependencies:** Tasks 2, 3

**Files:**
- `packages/ner-service/src/ner_service/pipeline/gliner.py` — MODIFY (~6 imports)
- `packages/ner-service/src/ner_service/pipeline/flair.py` — MODIFY (~8 imports)
- `packages/ner-service/src/ner_service/pipeline/ensemble.py` — MODIFY (~5 imports)
- `packages/ner-service/src/ner_service/llm/reviewer.py` — MODIFY (~8 imports)
- `packages/ner-service/src/ner_service/llm/validation.py` — MODIFY (~3 imports)
- `packages/ner-service/src/ner_service/input/request.py` — MODIFY (~2 imports)
- `packages/ner-service/src/ner_service/proto/ner_pb2_grpc.py` — MODIFY (~1 import)

**Estimated scope:** M (7 files, ~30 import changes)

---

#### Task 5: Populate all `__init__.py` files with `__all__`

**Description:** Write clean `__init__.py` for every sub-package. Each exports the public API via `__all__`. The root `__init__.py` re-exports key symbols for convenience but sub-package imports are the canonical path.

**Acceptance criteria:**
- [ ] `ner_service/__init__.py` — re-exports `__all__` from all sub-packages
- [ ] `ner_service/pipeline/__init__.py` — exports GlinerStage, FlairStage, merge_entities, MergedEntity
- [ ] `ner_service/llm/__init__.py` — exports LlmReviewer, validate_llm_output
- [ ] `ner_service/input/__init__.py` — exports validate_extract_request, ALLOWED_LABELS, MAX_TEXT_LENGTH
- [ ] `ner_service/utils/__init__.py` — exports text utilities
- [ ] `ner_service/proto/__init__.py` — exports ner_pb2, ner_pb2_grpc

**Verification:**
- [ ] `uv run python -c "from ner_service.config import settings; print(settings.GLINER_MODEL)"` works
- [ ] `uv run python -c "from ner_service.pipeline.ensemble import merge_entities"` works

**Dependencies:** Task 4

**Files:**
- `packages/ner-service/src/ner_service/__init__.py` — WRITE
- `packages/ner-service/src/ner_service/pipeline/__init__.py` — WRITE
- `packages/ner-service/src/ner_service/llm/__init__.py` — WRITE
- `packages/ner-service/src/ner_service/input/__init__.py` — WRITE
- `packages/ner-service/src/ner_service/utils/__init__.py` — WRITE
- `packages/ner-service/src/ner_service/proto/__init__.py` — WRITE

**Estimated scope:** S (6 __init__.py files)

---

#### Task 6: Split server.py into server.py + handler.py

**Description:** Extract the `NerService` class (lines ~75-223 in current server.py) into `handler.py`. The class becomes `NerServiceHandler` to clarify it's the RPC handler, not the gRPC server. `server.py` retains only lifecycle code: create gRPC server, register handler + health, model loading threads, signal handling, `serve()`.

Current `server.py` structure:
- Lines 1-30: imports
- Lines 31-32: logger
- Lines 34-73: `_build_proto_entity()` + helper functions
- Lines 75-223: `NerService` class (ExtractEntities RPC handler)
- Lines 227-237: `_start_model_loading()`
- Lines 240-280: `serve()` + `__main__`

After split:
- **handler.py** (~180 lines): imports, helper functions, `NerServiceHandler` class
- **server.py** (~100 lines): imports, `_start_model_loading()`, `serve()`, `__main__`

**Acceptance criteria:**
- [ ] `handler.py` contains `NerServiceHandler` class with `ExtractEntities` method
- [ ] `server.py` imports `NerServiceHandler` and registers it with `add_NerServiceServicer_to_server()`
- [ ] `python -m ner_service.server` starts the server (same entry point)
- [ ] Module-level behavior preserved: model loading threads, health check transitions

**Verification:**
- [ ] `uv run python -c "from ner_service.handler import NerServiceHandler"` works
- [ ] `uv run python -m ner_service.server` — starts and health reports SERVING (manual: ctrl-c after confirmation)

**Dependencies:** Tasks 4, 5

**Files:**
- `packages/ner-service/src/ner_service/server.py` — REWRITE (~100 lines)
- `packages/ner-service/src/ner_service/handler.py` — NEW (~180 lines, extracted from server.py)

**Estimated scope:** M (split 1 file → 2, ~100 lines each)

---

### Checkpoint: Source Refactored
- [ ] All imports resolve: `uv run python -c "from ner_service import config, server, handler"` works
- [ ] All `__init__.py` files export correct public APIs
- [ ] `handler.py` contains `NerServiceHandler` class
- [ ] `server.py` imports from `ner_service.handler`

---

### Phase 3: Tests & Verification (spec steps 13-15)

#### Task 7: Update all test imports

**Description:** Update imports in all 5 test files to use the new package structure. Test logic is unchanged — only imports change.

Import mapping for tests:

| File | Old import | New import |
|------|-----------|------------|
| `test_ensemble_merge.py` | `from ensemble_merge import merge, ...` | `from ner_service.pipeline.ensemble import merge, ...` |
| `test_llm_reviewer.py` | `from llm_reviewer import ...` | `from ner_service.llm.reviewer import ...` |
| `test_llm_validation.py` | `from llm_validation import ...` | `from ner_service.llm.validation import ...` |
| `test_server.py` | `import ner_pb2` | `from ner_service.proto import ner_pb2` |
| `test_validation.py` | `from validation import ...` | `from ner_service.input.request import ...` |
| all files | `import ner_pb2` | `from ner_service.proto import ner_pb2` |

**Acceptance criteria:**
- [ ] All 5 test files import from `ner_service.*` packages
- [ ] `uv run pytest` — all 66 tests pass

**Verification:**
- [ ] `uv run pytest -v` — 66 passed, 0 failed

**Dependencies:** Tasks 5, 6

**Files:**
- `packages/ner-service/tests/test_ensemble_merge.py` — MODIFY (~3 imports)
- `packages/ner-service/tests/test_llm_reviewer.py` — MODIFY (~3 imports)
- `packages/ner-service/tests/test_llm_validation.py` — MODIFY (~1 import)
- `packages/ner-service/tests/test_server.py` — MODIFY (~4 imports)
- `packages/ner-service/tests/test_validation.py` — MODIFY (~2 imports)

**Estimated scope:** S (5 files, ~15 import changes)

---

#### Task 8: Run full test suite and fix any breakage

**Description:** Run `uv run pytest -v`. If any imports or behavior break, fix them. This task exists because some test files may have internal assumptions about module paths that aren't captured in the import audit.

**Acceptance criteria:**
- [ ] `uv run pytest -v` — 66 passed
- [ ] No skipped or xfail tests
- [ ] Test output shows no deprecation warnings from restructured imports

**Verification:**
- [ ] `uv run pytest -v 2>&1 | tail -5` shows `66 passed`

**Dependencies:** Task 7

**Files:** `tests/*.py` (fix only if broken)

**Estimated scope:** XS (fixes only, no new code)

---

### Checkpoint: All Tests Green
- [ ] `uv run pytest` — 66/66 passing
- [ ] `python -m ner_service.server` (manual test) — starts and health returns SERVING
- [ ] Source tree is self-contained — no imports reference old flat files

---

### Phase 4: Docker & Build (spec steps 16-22)

#### Task 9: Update Dockerfile for new structure + PYTHONPATH

**Description:** Update `Dockerfile` to:
1. Install `uv` in the Docker image (via pip: `pip install uv`)
2. Copy `pyproject.toml` and `uv.lock` (generated by Task 1's `uv sync`, committed to git)
3. Run `uv sync --frozen --no-dev` for deterministic install from lockfile
4. Copy `src/` directory instead of `*.py`
5. Set `PYTHONPATH=/app/src` so `python -m ner_service.server` resolves (Dockerfile copies `src/` to `/app/src/`; WORKDIR is `/app`)
6. Generate proto to `src/ner_service/proto/`
7. Change `ENTRYPOINT` from `python server.py` to `python -m ner_service.server`
8. Preserve torch CPU-only install and HF cache dirs

**Acceptance criteria:**
- [ ] Dockerfile copies `pyproject.toml` + `uv.lock` + `src/` instead of `requirements.txt` + `*.py`
- [ ] `uv sync --frozen --no-dev` replaces `pip install -r requirements.txt`
- [ ] `ENV PYTHONPATH=/app/src` or equivalent so `ner_service` package is importable
- [ ] `ENTRYPOINT ["python", "-m", "ner_service.server"]`
- [ ] Proto output path: `src/ner_service/proto/`

**Verification:**
- [ ] `docker compose build ner-service` — succeeds
- [ ] `docker compose up -d ner-service` — container starts
- [ ] `docker logs deploy-ner-service-1 | grep SERVING` — healthy

**Dependencies:** Tasks 7, 8

**Files:**
- `packages/ner-service/Dockerfile` — MODIFY (~20 lines)

**Estimated scope:** S (1 file, ~20 lines)

---

#### Task 10: Update scripts and package.json

**Description:**
1. Move `compile_proto.sh` to `scripts/compile_proto.sh`
2. Update proto output path in `compile_proto.sh` to `src/ner_service/proto/`
3. Update `package.json` scripts for new paths (test, build commands)
4. Create `scripts/` directory

**Acceptance criteria:**
- [ ] `compile_proto.sh` generates protos to `src/ner_service/proto/`
- [ ] `package.json` `test` script uses `uv run pytest`
- [ ] `package.json` `build` script uses `scripts/compile_proto.sh`

**Verification:**
- [ ] `bash scripts/compile_proto.sh` — proto files written to `src/ner_service/proto/`
- [ ] `pnpm run test` from `packages/ner-service/` — runs pytest via uv

**Dependencies:** Task 3 (proto files already placed)

**Files:**
- `packages/ner-service/scripts/compile_proto.sh` — MOVE + MODIFY
- `packages/ner-service/compile_proto.sh` — DELETE
- `packages/ner-service/package.json` — MODIFY (~5 lines)

**Estimated scope:** XS (2 files, ~5 lines)

---

#### Task 11: Full Docker integration test

**Description:** Rebuild ner-service container, deploy, and verify:
1. Docker image builds without errors
2. Container starts and health check passes
3. gRPC server responds to health probe
4. TypeScript NER client (from api-gateway) connects and extracts entities
5. NER pipeline produces entities (entitiesExtracted > 0 in api-gateway logs)

**Acceptance criteria:**
- [ ] `docker compose build --no-cache ner-service` — success
- [ ] `docker compose up -d ner-service` — container healthy
- [ ] `docker logs deploy-ner-service-1 | grep "SERVING"`
- [ ] api-gateway logs show `NER: entity extraction pipeline initialized`
- [ ] api-gateway logs show `entitiesExtracted > 0`

**Verification:**
- [ ] Wait for api-gateway to connect: `docker logs deploy-api-gateway-1 | grep "NER:" | tail -3`

**Dependencies:** Tasks 9, 10

**Files:** None (integration test only)

**Estimated scope:** S (build + deploy + verify)

---

### Phase 5: Cleanup (spec steps 23-26)

#### Task 12: Remove old flat files

**Description:** Delete all `.py` files from the root `packages/ner-service/` directory that have been moved to `src/ner_service/`. Also delete `requirements.txt` and old `.venv/`.

Files to delete:
- `config.py`, `constants.py`, `logging_config.py` (merged into config)
- `server.py`, `ensemble_merge.py`, `flair_stage.py`, `gliner_stage.py`
- `llm_reviewer.py`, `llm_validation.py`, `validation.py`, `text_utils.py`
- `ner_pb2.py`, `ner_pb2_grpc.py` (moved to proto/)
- `compile_proto.sh` (moved to scripts/)
- `requirements.txt`
- `.venv/`

Files to keep at root:
- `pyproject.toml`, `package.json`, `.gitignore`, `Dockerfile`, `.dockerignore`
- `proto/ner.proto`

**Acceptance criteria:**
- [ ] No `.py` files in `packages/ner-service/` root
- [ ] `ls *.py` returns nothing
- [ ] `requirements.txt` deleted
- [ ] `.venv/` deleted

**Verification:**
- [ ] `find . -maxdepth 1 -name "*.py" | wc -l` → 0
- [ ] `uv run pytest` — still 66 passed (no stale .pyc interference)

**Dependencies:** Task 11

**Files:** 13 files DELETE

**Estimated scope:** XS (deletion only)

---

#### Task 13: Final verification

**Description:** Run the full verify chain end-to-end:
1. Tests pass
2. Docker build succeeds
3. Docker deploy succeeds
4. NER pipeline produces results via api-gateway

**Acceptance criteria:**
- [ ] `uv run pytest` — 66 passed
- [ ] `docker compose build ner-service` — success
- [ ] `docker compose up -d ner-service api-gateway` — both healthy
- [ ] Zero OBJECT_NOT_FOUND or NER errors in api-gateway logs
- [ ] `git status` — only new structure, no stale files

**Verification:**
- [ ] All checkpoints above confirmed

**Dependencies:** Task 12

**Files:** None

**Estimated scope:** S (verification only)

---

## Task Dependency Graph

```
Task 1 (scaffold + pyproject) ──┬── Task 2 (merge config)
                                │        │
                                ├── Task 3 (move files) ──┬── Task 4 (fix imports)
                                │                          │        │
                                │                          │   Task 5 (__init__.py)
                                │                          │        │
                                │                          │   Task 6 (split server)
                                │                          │        │
                                │                          └──┬─────┘
                                │                             │
                                │                        Task 7 (test imports)
                                │                             │
                                │                        Task 8 (run tests)
                                │                             │
                                │                        Task 9 (Dockerfile)
                                │                        Task 10 (scripts/pkg.json)
                                │                             │
                                │                        Task 11 (Docker test)
                                │                             │
                                │                        Task 12 (cleanup)
                                │                             │
                                └───────────────────── Task 13 (final verify)
```

Tasks 2 and 3 can run in parallel.
Tasks 4, 5, 6 can run partially in parallel (6 depends on 4+5).
Tasks 9 and 10 are independent of each other.

## Files Changed Summary

| Phase | Task | Files | Action | Lines |
|-------|------|-------|--------|-------|
| 1 | 1 | 7 | NEW | ~50 |
| 1 | 2 | 1 new, 3 del | MERGE | ~200 |
| 1 | 3 | 9 | COPY | — |
| 2 | 4 | 7 | MODIFY imports | ~30 |
| 2 | 5 | 6 | NEW __init__.py | ~40 |
| 2 | 6 | 1 new, 1 rewrite | SPLIT | ~280 |
| 3 | 7 | 5 | MODIFY imports | ~15 |
| 3 | 8 | 0 | verify | — |
| 4 | 9 | 1 | MODIFY | ~20 |
| 4 | 10 | 2 | MOVE+MODIFY | ~5 |
| 4 | 11 | 0 | verify | — |
| 5 | 12 | 13 | DELETE | — |
| 5 | 13 | 0 | verify | — |

Total: ~30 files, ~640 new/rewritten lines across 13 tasks.

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Import changes break at runtime that pass at import time | Medium | High | Run `uv run pytest` after every task. Tests exercise actual module imports. |
| Proto path changes break gRPC serialization | Low | High | `test_ensemble_merge.py` and `test_llm_reviewer.py` import `ner_pb2` — test failures catch this. |
| `config.py` merge changes logger format | Low | Medium | Preserve exact `python-json-logger` config. Test server startup validates log output. |
| Docker build fails due to uv not in base image | Low | Medium | Install uv via `pip install uv` in Dockerfile before `uv sync`. |
| Turborepo `package.json` test script breaks | Low | Low | Update script to `uv run pytest`. Test from root: `pnpm run test --filter=ner-service`. |
| Old `.pyc` files cause import confusion after old files deleted | Low | Low | Delete `__pycache__/` along with `.py` files. |

## Open Questions

- Confirm: commit `uv.lock` (addressed in spec — yes for reproducible Docker builds)
- Should `scripts/compile_proto.sh` be called from `package.json` `build` script? (Yes — current behavior preserved)

## Verification Gates

- [ ] After Task 2: `uv run python -c "from ner_service.config import settings"` works
- [ ] After Task 6: All imports resolve without old flat files
- [ ] After Task 8: 66/66 tests pass
- [ ] After Task 11: Docker ner-service healthy, api-gateway NER working
- [ ] After Task 13: Zero regressions, clean git status
