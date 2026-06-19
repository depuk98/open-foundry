---
title: ADR-008 — Automated Scaffold (Cardinal) + Human-Agent Collaboration
created: 2026-06-18
last_updated: 2026-06-18
type: decision
status: accepted
related_components:
  - all-platform-packages
---

# ADR-008: Automated Scaffold (Cardinal) + Human-Agent Collaboration

## Context

Open Foundry is a large platform — 20 packages, ~27,600 lines of TypeScript, ~2,100 lines of Go, ~33,000 lines of test code, ~1,700 lines of domain pack configuration, and ~2,200 lines of deployment configuration. Building this entirely by hand would take months of dedicated engineering effort. Building it entirely via automated code generation would produce code that compiles but lacks domain context, security hardening, and production readiness. We needed a build strategy that maximizes speed while retaining human judgment for quality-critical decisions.

## Decision

**A two-phase build process: Phase 1 — Automated scaffold via Cardinal (an AI task planning and execution system). Phase 2 — Human-agent collaborative expansion and hardening.**

### Phase 1: Cardinal

Cardinal decomposed the v2 technical specification into ~120 discrete tasks across 20 packages, ordered by dependency graph. Claude Opus 4.6, operating in parallel sessions, implemented each task autonomously: source code, tests, deployment configuration, and documentation. Cardinal managed dependencies between tasks, tracked progress, and ran 8 automated review passes to resolve consistency and type-safety issues. By the end of Phase 1, the platform had complete interfaces, implementations, tests, and deployment artifacts — a working scaffold.

### Phase 2: Human-Agent Collaboration

A human engineer reviewed the codebase, revised the specification, and drove iterative hardening:
- **Spec refinement** — Three rounds addressing gaps in directives, resilience, lifecycle, and federation contracts.
- **Domain expansion** — Two new domain packs (AML, Supply Chain) with full schemas, actions, connectors, and permission models.
- **Feature additions** — Aggregation queries, full-text search, object sets, connector plugin architecture, distributed rate limiting, persistent event bus, and OpenTelemetry instrumentation.
- **Security hardening** — Multiple review rounds (including cross-model Codex reviews) identified and fixed 200+ issues across auth pipelines, SQL injection, field-level redaction, system-field mapping, error message sanitization, CORS fail-closed, proxy-aware rate limiting, advisory lock safety, and schema migration integrity.
- **Production hardening** — Structured logging, query complexity gates, idempotency caching, connection timeouts, graceful shutdown, non-root containers, Helm PDBs, and network policies.
- **Postgres integration** — Idempotent DDL generation, link table schema alignment, traversal behavior parity, and 110 integration tests.

## Alternatives Considered

- **All manual development** — A traditional engineering team building everything from scratch. Rejected because: the scale of the platform (~60K lines of code + config) would require months of development time. The spec alone is 3,100 lines. The opportunity cost of not leveraging AI for the scaffold phase is too high for an open-source project with no dedicated engineering team.
- **All automated generation** — Let the AI system build everything end-to-end without human review. Rejected because: automated code generation produces syntactically correct but semantically shallow code. Security hardening (CORS fail-closed, SQL injection prevention, redaction correctness) requires adversarial thinking that current LLMs do not reliably demonstrate. The 200+ security issues found during human review prove this point.
- **Contracted engineering team** — Hire a team to build the platform. Rejected because: cost-prohibitive for an Apache 2.0 open-source project, creates handoff problems between the team and the maintainer, and would not produce the self-documenting knowledge base that AI-assisted development creates (ADRs, concept pages, activity logs).

## Consequences

### What becomes easier

- **Speed of initial construction** — A 20-package platform with complete interfaces, implementations, and tests was scaffolded in a fraction of the time manual development would require. The scaffold provided a working foundation for iterative refinement.
- **Knowledge retention** — Every decision, concept, and feature is documented in `docs/` as a first-class artifact. The AI-assisted process produced structured documentation ([[adr-001-odl-as-graphql-sdl]], [[adr-002-cel-go-sidecar]], etc.) that manual development often defers. The project explains itself to the next contributor.
- **Economic use of expertise** — Human judgment is applied where it matters most: architecture review, security hardening, domain expertise. Routine implementation (CRUD operations, schema compilation, test generation) is automated.
- **Reproducible process** — The two-phase build pattern is documented and repeatable. Future platform extensions or new domain packs can follow the same scaffold → harden pattern. The Cardinal task decomposition approach is generalizable.

### What becomes harder

- **Phase boundary management** — The transition from automated scaffold to human-agent collaboration requires clear acceptance criteria. The scaffold must be "complete enough" to serve as a foundation but not so polished that the human engineer cannot distinguish generated code from reviewed code. The 8 automated review passes helped, but some issues (e.g., security vulnerabilities) were only visible under adversarial human review.
- **Maintaining generated code quality** — AI-generated code follows patterns well but can produce subtle inconsistencies. The cross-model review approach (using Claude to review code generated by Claude) catches some issues but is not a substitute for a second human reviewer. The 200+ security fixes demonstrate this limitation.
- **Knowledge transfer** — The human engineer must understand the full codebase before hardening it. Reading 27,600 lines of AI-generated TypeScript is a significant upfront investment. The self-documenting approach (`docs/` pages, cross-references) mitigates this by providing a structured knowledge graph.

## Sources

- [Source: README.md — How This Was Built]
- [Source: README.md — By the Numbers]
- [Source: AGENTS.md — What This Is: self-documenting software project]
- [Source: open-foundry-spec-v2.md — Full technical specification (3,104 lines)]

## Related

- [[adr-007-monorepo-turborepo]] — The monorepo structure that Cardinal scaffolded
- [[adr-004-spi-storage-abstraction]] — The SPI pattern that enabled independent package development
- [[adr-001-odl-as-graphql-sdl]] — ODL as GraphQL SDL, which Cardinal's ODL compiler implements
