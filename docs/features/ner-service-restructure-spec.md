---
title: NER Service Restructure — uv Migration & Directory Cleanup
created: 2026-06-20
type: spec
status: proposed
related_components:
  - ner-service
related_features:
  - osint-domain-pack
  - ner-three-stage-pipeline-spec
related_decisions:
  - adr-012-ner-python-sidecar
---

# Spec: NER Service Restructure — uv Migration & Directory Cleanup

## 1. Objective

Restructure `packages/ner-service` from a flat, organically-grown layout into a clean, navigable Python package using `uv` as the package manager. The current structure has all 12 `.py` files dumped in a single directory with no sub-packages, generated protobuf artifacts mixed with source, and a `requirements.txt` + `.venv` workflow that isn't reproducible across machines.

**Success looks like:**
- `uv sync` installs all dependencies and creates a reproducible lockfile
- `uv run pytest` runs the full test suite (66 tests)
- Source code organized into logical sub-packages (pipeline, llm, validation, utils, proto)
- Generated protobuf files isolated from hand-written source
- `Dockerfile` builds successfully with the new structure
- Docker compose `ner-service` starts healthy
- Zero behavioral changes — same gRPC API, same NER outputs

## 2. Current State (Problems)

### 2.1 Flat directory — 12 files in root

```
ner-service/
├── __init__.py          # 11 lines — exports config, logging_config only
├── config.py            # 113 lines
├── constants.py         # 23 lines — should be merged into config
├── server.py            # 280 lines — gRPC server + handler logic in one file
├── ensemble_merge.py    # 219 lines — pipeline stage
├── flair_stage.py       # 145 lines — pipeline stage
├── gliner_stage.py      # 129 lines — pipeline stage
├── llm_reviewer.py      # 313 lines — LLM stage + Ollama client
├── llm_validation.py    # 98 lines — LLM output sanitization
├── logging_config.py    # 67 lines — should be in config
├── text_utils.py        # 20 lines — text helpers
├── validation.py        # 50 lines — gRPC input validation
├── ner_pb2.py           # generated — mixed with source
├── ner_pb2_grpc.py      # generated — mixed with source
├── requirements.txt     # 8 deps, no lockfile
├── compile_proto.sh     # shell script for proto generation
└── tests/               # flat test directory
```

**Problems:**
1. No logical grouping — `gliner_stage.py`, `flair_stage.py`, `ensemble_merge.py` are all pipeline stages but sit alongside `server.py` and `config.py`
2. Generated protobuf files (`ner_pb2.py`, `ner_pb2_grpc.py`) mixed with hand-written source
3. `constants.py` (23 lines) and `logging_config.py` (67 lines) are too small to justify separate files
4. `server.py` does two jobs: gRPC server lifecycle + entity extraction handler
5. `requirements.txt` has no lockfile — `pip install` is non-deterministic across machines
6. `.venv` directory committed alongside source (should be gitignored)
7. `__init__.py` exports only 2 of 12 modules — no real public API

### 2.2 Package manager: pip + requirements.txt

```text
grpcio>=1.60.0
grpcio-tools>=1.60.0
grpcio-health-checking>=1.60.0
gliner>=0.2.0
flair>=0.15.0
httpx>=0.27.0
python-json-logger>=2.0.0
pyyaml>=6.0
```

No `pyproject.toml`, no lockfile, torch installed separately in Dockerfile.

## 3. Target State

### 3.1 Directory Structure

```
packages/ner-service/
├── pyproject.toml                 # uv-managed: metadata, deps, scripts
├── uv.lock                        # generated: reproducible lockfile
├── Dockerfile                     # updated for new structure
├── package.json                   # turbo build orchestration (unchanged)
├── .gitignore                     # add .venv, __pycache__
├── proto/
│   └── ner.proto                  # protobuf service definition (unchanged)
├── src/
│   └── ner_service/
│       ├── __init__.py            # public API: re-exports all modules
│       ├── config.py              # merged: config + constants + logging
│       ├── server.py              # gRPC server lifecycle only
│       ├── handler.py             # NEW: ExtractEntities RPC handler logic
│       ├── pipeline/
│       │   ├── __init__.py        # re-exports stages
│       │   ├── gliner.py          # GLiNER zero-shot NER stage
│       │   ├── flair.py           # Flair standard NER stage
│       │   └── ensemble.py        # confidence-weighted merge
│       ├── llm/
│       │   ├── __init__.py        # re-exports reviewer + validation
│       │   ├── reviewer.py        # phi4-mini LLM verification via Ollama
│       │   └── validation.py      # LLM output sanitization
│       ├── input/                   # input request validation
│       │   ├── __init__.py
│       │   └── request.py            # gRPC input validation
│       ├── utils/
│       │   ├── __init__.py
│       │   └── text.py            # text utility helpers
│       └── proto/
│           ├── __init__.py
│           ├── ner_pb2.py         # generated
│           └── ner_pb2_grpc.py    # generated
├── tests/
│   ├── __init__.py
│   ├── test_server.py
│   ├── test_validation.py
│   ├── test_llm_validation.py
│   ├── test_llm_reviewer.py
│   └── test_ensemble_merge.py
├── scripts/
│   └── compile_proto.sh           # proto compilation (moved from root)
└── .venv/                         # uv-managed (gitignored)
```

### 3.2 Module Responsibilities

| Module | Responsibility | Lines (est.) |
|--------|---------------|------|
| `ner_service.config` | All configuration: env vars, defaults, constants, logging setup | ~200 |
| `ner_service.server` | gRPC server lifecycle: create, register, start, health check, signal handling | ~100 |
| `ner_service.handler` | `ExtractEntities()` RPC: orchestrate pipeline, build proto response | ~150 |
| `ner_service.pipeline.gliner` | GLiNER zero-shot extraction + context enrichment | ~130 |
| `ner_service.pipeline.flair` | Flair standard NER extraction + tag mapping | ~145 |
| `ner_service.pipeline.ensemble` | Confidence-weighted merge, conflict detection, TYPE_RESOLUTION | ~220 |
| `ner_service.llm.reviewer` | phi4-mini chat via Ollama, prompt building, response parsing | ~315 |
| `ner_service.llm.validation` | LLM output sanitization: action/type/span validation | ~100 |
| `ner_service.input.request` | gRPC request validation: text, labels, confidence, max_entities | ~50 |
| `ner_service.utils.text` | Text utility helpers | ~20 |
| `ner_service.proto` | Generated protobuf stubs (unchanged) | ~150 |

### 3.3 `pyproject.toml` (uv)

```toml
[project]
name = "ner-service"
version = "0.1.0"
description = "Three-stage NER pipeline gRPC sidecar (GLiNER + Flair + phi4-mini)"
requires-python = ">=3.11"
dependencies = [
    "grpcio>=1.60.0",
    "grpcio-tools>=1.60.0",
    "grpcio-health-checking>=1.60.0",
    "gliner>=0.2.0",
    "flair>=0.15.0",
    "httpx>=0.27.0",
    "python-json-logger>=2.0.0",
    "pyyaml>=6.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=7.4.0",
]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["src"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
```

### 3.4 Dockerfile Changes

Key changes from current Dockerfile:
- `pip install` → `uv sync` for deterministic installs
- `COPY packages/ner-service/*.py ./` → `COPY packages/ner-service/pyproject.toml packages/ner-service/uv.lock ./` then `COPY packages/ner-service/src/ ./src/`
- `ENTRYPOINT ["python", "server.py"]` → `ENTRYPOINT ["python", "-m", "ner_service.server"]`
- Proto output goes to `src/ner_service/proto/` instead of flat root

## 4. Commands

```bash
# Development
uv sync                          # install deps + create lockfile
uv sync --dev                    # install with test deps
uv run pytest                    # run tests (66 tests)
uv run python -m ner_service.server  # start gRPC server

# Proto
bash scripts/compile_proto.sh    # regenerate protobuf stubs

# Docker
cd deploy && docker compose build --no-cache ner-service
cd deploy && docker compose up -d ner-service

# Verify
docker logs deploy-ner-service-1 | grep "SERVING"
```

## 5. Code Style

### 5.1 Imports — absolute from `ner_service` package

```python
# server.py
from ner_service.config import settings
from ner_service.handler import NerServiceHandler
from ner_service.proto import ner_pb2, ner_pb2_grpc

# handler.py
from ner_service.pipeline.gliner import GlinerStage
from ner_service.pipeline.flair import FlairStage
from ner_service.pipeline.ensemble import merge_entities
from ner_service.llm.reviewer import LlmReviewer
from ner_service.llm.validation import validate_llm_output
from ner_service.input.request import validate_extract_request
from ner_service.utils.text import extract_context
```

### 5.2 Every `__init__.py` defines `__all__`

`__init__.py` files WITHIN the package may use relative imports (`from .gliner import GlinerStage`). All other source files use absolute imports (`from ner_service.pipeline.gliner import GlinerStage`).

```python
# src/ner_service/pipeline/__init__.py — relative OK (same package)
from .gliner import GlinerStage
from .flair import FlairStage
from .ensemble import merge_entities, MergedEntity

__all__ = ["GlinerStage", "FlairStage", "merge_entities", "MergedEntity"]
```

### 5.3 Type hints on all public functions

### 5.4 Imports — absolute from `ner_service` package (except `__init__.py`)

## 6. Testing Strategy

- **Framework:** pytest (unchanged)
- **Test location:** `tests/` directory parallel to `src/`
- **Test runner:** `uv run pytest` — no venv activation needed
- **Test files:** follow source module naming: `tests/test_ensemble_merge.py` maps to `src/ner_service/pipeline/ensemble.py`
- **Coverage:** maintain existing 66 test count, no regression allowed

## 7. Migration Steps (Execution Order)

### Phase 1: Scaffold (no behavioral changes)
- [ ] 1. Create `src/ner_service/` directory tree with all sub-packages
- [ ] 2. Create `pyproject.toml` with uv configuration
- [ ] 3. Create `.gitignore` entries for `.venv`, `__pycache__`, `uv.lock`
- [ ] 4. Create `scripts/` directory, move `compile_proto.sh`

### Phase 2: Move & Refactor (zero behavioral changes)
- [ ] 5. Move `config.py` + `constants.py` + `logging_config.py` → `src/ner_service/config.py` (merge)
- [ ] 6. Move pipeline stages: `gliner_stage.py` → `pipeline/gliner.py`, `flair_stage.py` → `pipeline/flair.py`, `ensemble_merge.py` → `pipeline/ensemble.py`
- [ ] 7. Move LLM: `llm_reviewer.py` → `llm/reviewer.py`, `llm_validation.py` → `llm/validation.py`
- [ ] 8. Move validation + utils: `validation.py` → `input/request.py`, `text_utils.py` → `utils/text.py`
- [ ] 9. Split `server.py`: extract handler logic → `handler.py`, keep server lifecycle in `server.py`
- [ ] 10. Move generated proto files → `src/ner_service/proto/`
- [ ] 11. Create all `__init__.py` files with `__all__`
- [ ] 12. Update all imports from flat module to package-qualified

### Checkpoint: All imports resolve, zero behavioral changes
- [ ] 13. Run `uv sync` — installs deps, creates lockfile
- [ ] 14. Run `uv run pytest` — all 66 tests pass
- [ ] 15. Run `uv run python -m ner_service.server` — starts and responds to health check

### Phase 3: Docker & Integration
- [ ] 16. Update `Dockerfile` for new structure + uv
- [ ] 17. Update `compile_proto.sh` for new output path
- [ ] 18. Update `package.json` scripts for new paths
- [ ] 19. Rebuild Docker image: `docker compose build --no-cache ner-service`
- [ ] 20. Deploy: `docker compose up -d ner-service`
- [ ] 21. Verify health: `docker logs deploy-ner-service-1 | grep SERVING`
- [ ] 22. Full pipeline test: ensure TypeScript NER client connects and extracts entities

### Phase 4: Cleanup
- [ ] 23. Remove old flat files from root
- [ ] 24. Remove `requirements.txt` and old `.venv`
- [ ] 25. Remove `compile_proto.sh` from root (now in `scripts/`)
- [ ] 26. Verify `git status` shows only new structure, no stale files

## 8. Files Touched

| File | Action | Lines |
|------|--------|-------|
| `pyproject.toml` | NEW | ~35 |
| `.gitignore` | MODIFY | +3 lines |
| `src/ner_service/__init__.py` | NEW | ~15 |
| `src/ner_service/config.py` | MERGE (3→1) | ~200 |
| `src/ner_service/server.py` | SPLIT | ~100 |
| `src/ner_service/handler.py` | EXTRACT | ~150 |
| `src/ner_service/pipeline/__init__.py` | NEW | ~6 |
| `src/ner_service/pipeline/gliner.py` | MOVE+RENAME | ~130 |
| `src/ner_service/pipeline/flair.py` | MOVE+RENAME | ~145 |
| `src/ner_service/pipeline/ensemble.py` | MOVE+RENAME | ~220 |
| `src/ner_service/llm/__init__.py` | NEW | ~6 |
| `src/ner_service/llm/reviewer.py` | MOVE+RENAME | ~315 |
| `src/ner_service/llm/validation.py` | MOVE+RENAME | ~100 |
| `src/ner_service/input/__init__.py` | NEW | ~5 |
| `src/ner_service/input/request.py` | MOVE+RENAME | ~50 |
| `src/ner_service/utils/__init__.py` | NEW | ~5 |
| `src/ner_service/utils/text.py` | MOVE+RENAME | ~20 |
| `src/ner_service/proto/__init__.py` | NEW | ~5 |
| `src/ner_service/proto/ner_pb2.py` | MOVE | 0 |
| `src/ner_service/proto/ner_pb2_grpc.py` | MOVE | 0 |
| `tests/__init__.py` | UPDATE | ~3 |
| `tests/test_server.py` | UPDATE imports | ~5 |
| `tests/test_llm_validation.py` | UPDATE imports | ~5 |
| `tests/test_llm_reviewer.py` | UPDATE imports | ~5 |
| `tests/test_validation.py` | UPDATE imports | ~3 |
| `tests/test_ensemble_merge.py` | UPDATE imports | ~5 |
| `scripts/compile_proto.sh` | MOVE | ~5 |
| `Dockerfile` | UPDATE | ~15 |
| `package.json` | UPDATE | ~5 |

Total: ~30 files, ~200 new lines, ~1,500 moved lines.

## 9. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Import breakage after restructure | tests fail, server won't start | Run `uv run pytest` after every file move. Fix imports incrementally. |
| Docker build fails with new structure | CI blocked | Test `docker compose build ner-service` after Phase 3 step 16. |
| uv not available in Docker base image | build fails | Install uv in Dockerfile: `pip install uv` before `uv sync`. |
| Proto generation path mismatch | gRPC calls fail | Verify proto output path in `compile_proto.sh` and `handler.py`. |
| Turborepo `package.json` scripts need path updates | `pnpm run test` fails from root | Update `test` and `build` scripts in `package.json`. |

## 10. Boundaries

- **Always:** Run `uv run pytest` after any file move. Keep all 66 tests passing. Zero behavioral changes to NER pipeline logic.
- **Ask first:** Changes to Dockerfile base image. Changes to proto service definition (`ner.proto`). Adding new dependencies.
- **Never:** Delete `proto/ner.proto`. Change the gRPC API (method names, request/response shapes). Remove or skip tests. Commit `.venv` or `__pycache__`.

## 11. Success Criteria

| # | Criterion | Verification |
|---|-----------|-------------|
| 1 | `uv sync` installs all deps | Run from `packages/ner-service/` — no errors |
| 2 | `uv run pytest` — all 66 tests pass | `66 passed` output |
| 3 | `uv run python -m ner_service.server` starts | Health check reports SERVING |
| 4 | Source code in `src/ner_service/` with sub-packages | `find src/ner_service -name "*.py" | wc -l` → 18+ |
| 5 | No `.py` files in `packages/ner-service/` root except `src/` tree | `ls *.py` → no output |
| 6 | Docker build succeeds | `docker compose build ner-service` exit 0 |
| 7 | Docker health check passes | `docker logs deploy-ner-service-1 \| grep SERVING` |
| 8 | TypeScript gRPC client connects | NER logs appear in api-gateway with `entitiesExtracted > 0` |
| 9 | Generated protos in `src/ner_service/proto/` only | `ls src/ner_service/proto/` → `__init__.py`, `ner_pb2.py`, `ner_pb2_grpc.py` |
| 10 | Old files cleaned up | `requirements.txt`, old `.venv`, root `*.py` files (except `src/`) gone |

## 12. Open Questions

1. ~~Should `uv.lock` be committed to git?~~ **Resolved: Yes.** `uv.lock` is committed for reproducible Docker builds. UV docs recommend committing it for applications. Not in `.gitignore`.
2. Should the `scripts/` directory be at `packages/ner-service/` level or `packages/ner-service/src/ner_service/` level? (Recommend: top-level `scripts/` — it's a dev tool, not runtime code.)
3. Does turborepo's `package.json` need the `build` and `test` scripts to stay as-is? (Check: yes — `test: "python -m pytest tests/ -v"` needs update to use `uv run pytest`.)
