---
name: unified-agent-engine-docs
description: Creates/updates component, feature, ADR, concept, and synthesis pages for the Unified Agent Engine project. Use when documenting components, features, decisions, or the project index.
---

## When to use
- Creating a new page in `open-foundry/docs/components/`, `open-foundry/docs/features/`, `open-foundry/docs/decisions/`, `open-foundry/docs/concepts/`, or `open-foundry/docs/syntheses/`
- Updating `open-foundry/docs/index.md`
- Adding cross-references between pages
- Asked to document a component, feature, or architectural decision

## Page Templates

### Component Page (`open-foundry/docs/components/`)
```markdown
---
title: Component Name
created: YYYY-MM-DD
last_updated: YYYY-MM-DD
type: component
package: "@openfoundry/package-name"
status: active
related_components:
  - spi
  - api
---

# Component Name
One-paragraph summary of what this component does.

## Public API
- Key exports, classes, functions

## Dependencies
- What this component depends on (other packages, external services)

## Used By
- What depends on this component

## Key Design Decisions
- [[decision-xyz]] — why we chose this approach

## Test Coverage
- N unit tests, N integration tests

## Sources
- [Source: spec-file.md Section X]
```

### Feature Page (`open-foundry/docs/features/`)
```markdown
---
title: Feature Name
created: YYYY-MM-DD
last_updated: YYYY-MM-DD
type: feature
status: active | in-progress | planned | complete
related_components:
  - engine
  - api
related_decisions:
  - decision-xyz
---

# Feature Name
One-paragraph summary.

## Scope
- What's included

## Implementation
- How it was built, key files

## Connectors (if applicable)
- [[connector-name]] — what it integrates with

## Status & Roadmap
- Current state, pending work

## Sources
- [Source: spec-file.md Section X]
```

### ADR Page (`open-foundry/docs/decisions/adr-NNN-title.md`)
```markdown
---
title: Decision Title
created: YYYY-MM-DD
type: decision
status: accepted | proposed | superseded
---

# ADR: Decision Title

## Context
What problem are we solving?

## Decision
What did we choose?

## Alternatives Considered
- Alternative A — why rejected
- Alternative B — why rejected

## Consequences
What becomes easier? What becomes harder?

## Sources
- [Source: spec-file.md]
```

### Concept Page (`open-foundry/docs/concepts/`)
```markdown
---
title: Concept Name
created: YYYY-MM-DD
type: concept
related_components:
  - component-a
---

# Concept Name
Explanation of the pattern, methodology, or technical concept.
```

### Synthesis Page (`open-foundry/docs/syntheses/`)
```markdown
---
title: Synthesis Name
created: YYYY-MM-DD
type: synthesis
related_components:
  - component-a
related_features:
  - feature-x
---

# Synthesis Name
Cross-cutting analysis: architecture overview, trade-off map, or integration flow.
```

## Naming Conventions
- **Component pages**: match the package name (e.g., `ontology-engine.md`, `sync-engine.md`)
- **Feature pages**: kebab-case descriptive (e.g., `nhs-acute-pilot.md`, `osint-domain-pack.md`)
- **Decision pages**: `adr-NNN-title.md` (e.g., `adr-001-cel-go-sidecar.md`)
- **Concept pages**: kebab-case (e.g., `rebec-authorization.md`, `odl-schema-driven.md`)
- **Synthesis pages**: kebab-case (e.g., `architecture-overview.md`)
- Page filenames must match the `title` in frontmatter (kebab-case)

## Cross-References
- Use `[[page-name]]` wikilinks between pages
- Every component page must link to features that use it
- Every feature page must link to components it touches
- Every decision must link to affected components/features
- **Backlinks are mandatory**: if A links to B, B must link back to A

## Index Protocol (`open-foundry/docs/index.md`)
- Update `open-foundry/docs/index.md` whenever you create a new page
- Update `last_updated` date
- Verify total counts (components, features, decisions, concepts, syntheses) are accurate
- Format: `[[page-name]] — One-line description` under the correct section

## Verification
- All new pages have proper frontmatter (`title`, `created`, `type`, `status`)
- Cross-references added in both directions
- `open-foundry/docs/index.md` updated with new entry and accurate counts
