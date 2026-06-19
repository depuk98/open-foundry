# Unified Agent Engine — Agent Operating Instructions

> Read it first, always.

## Session Protocol (CRITICAL)

At session start: read `open-foundry/docs/index.md` and `open-foundry/docs/log.md` (last 5 entries for recent activity).
At session end: verify all actions logged, index reflects current state.

## Skill Usage (CRITICAL)

Before any task, scan available skills in your system prompt and use them when applicable. **If a skill matches, load it with `skill({ name: "..." })` and follow it exactly.**

Two project-specific skills:
- `unified-agent-engine-logging` — Logs every action to `open-foundry/docs/log.md`. Use after every action. No exceptions.
- `unified-agent-engine-docs` — Creates/updates component, feature, ADR, concept, and synthesis pages. Use when documenting anything.

### Lifecycle mapping
- DEFINE → `spec-driven-development`, `idea-refine`, `interview-me`
- PLAN → `planning-and-task-breakdown`
- BUILD → `incremental-implementation`, `test-driven-development`, `frontend-ui-engineering`, `api-and-interface-design`
- VERIFY → `debugging-and-error-recovery`, `browser-testing-with-devtools`
- REVIEW → `code-review-and-quality`, `security-and-hardening`, `performance-optimization`
- SHIP → `git-workflow-and-versioning`, `ci-cd-and-automation`, `shipping-and-launch`

When implementing or planning, read the relevant files in `open-foundry/docs/components/`, `open-foundry/docs/features/`, and `open-foundry/docs/concepts/` for context on existing architecture and patterns.

### Subagents
Delegate specialized work to subagents via the `task` tool. Examples: `code-reviewer`, `debugger`, `performance-engineer`. Run independent workstreams in parallel when possible.

### Commands
Suggest relevant `/commands` to the user (e.g., `/smart-debug`, `/full-review`, `/doc-generate`).

## Project Knowledge (`open-foundry/docs/`)

The LLM owns and maintains `open-foundry/docs/`. It's the compiled project knowledge.
- `docs/index.md` — Catalog of everything (read on every session)
- `docs/log.md` — Chronological activity record (append-only)
- `docs/components/` — One page per package/module
- `docs/features/` — One page per feature/domain pack
- `docs/decisions/` — Architecture Decision Records (ADRs)
- `docs/concepts/` — Patterns, methodologies, technical concepts
- `docs/syntheses/` — Cross-cutting analyses

`open-foundry/specs/` is equivalent to `raw/` — immutable reference documents. Read from them, cite them, never modify them.

## Architecture (short reference)

- **ODL** — Ontology Definition Language (GraphQL SDL + semantic directives)
- **CEL** — Common Expression Language for action preconditions/effects
- **ReBAC** — Relationship-Based Access Control via OpenFGA
- **CDC** — Change Data Capture via Debezium for sync
- **Pipeline**: validate → authorize → consent → preconditions → execute → side-effects → audit
- **Domain packs**: composable ODL schema + YAML action manifests + OpenFGA model extensions

For deeper context, read `open-foundry/docs/concepts/` and the spec files in `open-foundry/specs/`.

## Never
- Write code without checking for a matching skill first
- Skip logging — every action must produce an `open-foundry/docs/log.md` entry
- Skip tests — follow `test-driven-development` when changing behavior
- Modify files in `open-foundry/specs/` — they are read-only reference
- Make large changes in one shot — use `incremental-implementation`
