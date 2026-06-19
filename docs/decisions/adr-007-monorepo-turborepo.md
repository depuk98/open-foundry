---
title: ADR-007 — pnpm + Turborepo Monorepo
created: 2026-06-18
last_updated: 2026-06-18
type: decision
status: accepted
related_components:
  - spi
  - odl-compiler
  - ontology-engine
  - actions
  - api-gateway
  - security-service
---

# ADR-007: pnpm + Turborepo Monorepo

## Context

Open Foundry comprises 20 packages across four workspace roots: 12 core platform packages (`packages/`), 4 domain packs (`domain-packs/`), 3 test packages (`tests/`), and 1 tool package (`tools/`). These packages have deep interdependencies — `@openfoundry/api` depends on `@openfoundry/actions`, which depends on `@openfoundry/engine`, which depends on `@openfoundry/spi`. We needed a repository structure and build system that enables fast parallel builds, strict dependency management, efficient caching, and unified versioning across the entire platform.

## Decision

**pnpm workspace + Turborepo monorepo with four workspace roots.** pnpm provides strict dependency resolution (non-hoisted by default), disk-efficient storage via a global content-addressable store, and workspace protocol for intra-repo dependencies. Turborepo orchestrates parallel builds, caches task outputs, and manages the dependency graph across all packages.

Workspace roots:
- `packages/` — 12 core platform packages
- `domain-packs/` — 4 domain packs (core, nhs-acute, aml, supply-chain)
- `tests/` — 3 test packages (spi-conformance, pilot-scenarios, integration-tests)
- `tools/` — 1 tool package (seed-nhs-acute)

Key build configuration: `pnpm run build` compiles all packages in dependency order. `pnpm run test` runs all unit tests. `pnpm run test:integration` runs Docker Compose-backed integration tests. The Turborepo pipeline uses `dependsOn` to ensure `build` runs before `test`, and `^build` for cross-package dependencies.

## Alternatives Considered

- **Nx** — Powerful monorepo tool with advanced dependency graph visualization and distributed task execution. Rejected because: Nx is heavier and more opinionated than needed for 20 packages. Its plugin ecosystem (NestJS, Angular, React) adds configuration overhead that does not apply to a TypeScript library platform. Turborepo's simplicity and speed (parallel execution, remote caching) are a better fit.
- **Lerna** — The original JavaScript monorepo tool. Rejected because: Lerna has been largely superseded by Nx and Turborepo for performance. Its default hoisted dependency model causes phantom dependency issues. Lerna + pnpm works but adds another layer of tooling without Turborepo's caching.
- **Separate repositories** — One repo per package. Rejected because: cross-package changes (e.g., adding a field to the SPI interface affects every storage provider and the ontology engine) would require coordinated PRs across 20 repos. Versioning and release orchestration would be exponentially more complex. The SPI contract changes frequently enough that separate repos would create constant integration friction.
- **Single package (no monorepo)** — One large package containing everything. Rejected because: violates composability — the SPI, storage providers, domain packs, and tests must be independently versioned, published, and consumed. A single package would force consumers to install the entire platform, defeating the Domain Pack model of runtime-loadable, composable bundles.

## Consequences

### What becomes easier

- **Fast parallel builds** — Turborepo builds independent packages in parallel. A change to `@openfoundry/odl` triggers rebuilds of downstream dependents (`@openfoundry/engine`, `@openfoundry/api`, `@openfoundry/sdk`), but unrelated packages (e.g., `@openfoundry/sync`, `@openfoundry/observability`) are cached and skipped.
- **Strict dependency management** — pnpm's non-hoisted node_modules prevent phantom dependencies. A package cannot import a dependency it hasn't declared. This catches missing `dependencies` entries at build time, not at runtime in production.
- **Unified versioning** — All packages share a single `pnpm-lock.yaml` and can be versioned in lockstep. Cross-package breaking changes are visible in a single diff. The `workspace:*` protocol ensures intra-repo dependencies always resolve to the local build.
- **Domain packs as workspace packages** — Domain packs live in the monorepo alongside the platform, enabling integration tests that exercise the full stack with real domain pack schemas, actions, and permission models. External domain packs (loaded via `DOMAIN_PACKS_EXTRA_DIRS`) extend this model for organizations that maintain private packs outside the monorepo.
- **CI efficiency** — Turborepo's remote caching (when configured) means CI builds only recompile packages that changed. With 20 packages and ~27,600 lines of TypeScript, full rebuilds are avoided in most PRs.

### What becomes harder

- **Monorepo coupling risk** — All packages share a single repository, creating the temptation to introduce tight coupling between packages that should be loosely coupled. The SPI interface is the primary defense against this — packages depend on interfaces, not implementations. But the discipline must be maintained through code review.
- **Build dependency ordering** — The Turborepo pipeline must accurately reflect the package dependency graph. Adding a new package requires updating the pipeline configuration and ensuring `dependsOn` relationships are correct. A missed dependency can cause flaky builds where package A compiles against a stale build of package B.
- **Go sidecar integration** — The `cel-evaluator` Go service does not participate in the pnpm/Turborepo build. It has its own Go module and Docker build. The monorepo must bridge two build systems, which adds complexity to CI and local development setup. See [[adr-002-cel-go-sidecar]].

## Sources

- [Source: README.md — Packages: 20 packages across four workspace roots]
- [Source: README.md — Getting Started: pnpm install, pnpm run build]
- [Source: open-foundry-spec-v2.md Appendix D — Directory Structure]
- [Source: AGENTS.md — Reference: Package Architecture]

## Related

- [[adr-004-spi-storage-abstraction]] — The SPI interface that enables loose coupling between packages
- [[adr-008-two-phase-build]] — How the monorepo was scaffolded by Cardinal in Phase 1
