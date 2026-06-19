---
name: unified-agent-engine-logging
description: Logs every LLM action into the Unified Agent Engine activity log. Use after any plan, implement, debug, refactor, integrate, review, test, lint, or decide action.
---

## When to use
Use this skill after EVERY action you take in this project. If you touch the codebase, you log it. No exceptions.

## Log Format (`open-foundry/docs/log.md`)
Append-only chronological record. Each entry follows this format:

```markdown
## [YYYY-MM-DD] action-type | Short description of what happened
Details: what was done, which files changed, why, what the outcome was.
Components touched: [[component-a]], [[component-b]]
Features touched: [[feature-x]]
Decisions made: [[decision-y]]
```

## Action Types

| Action | When to Use | Required Log Details |
|--------|-----------|---------------------|
| `plan` | You create an implementation plan or architectural design | The plan summary, key decisions, affected components, the plan file path |
| `implement` | You build a feature, component, or fix | What was built, files changed, tests added, any deviations from plan |
| `integrate` | You add a connector, domain pack, or external dependency | What was integrated, the interface, any configuration needed |
| `refactor` | You restructure existing code without changing behavior | What changed, why, before/after structure |
| `debug` | You investigate and fix a bug | Root cause, fix applied, how verified |
| `decide` | You make a significant architectural choice | The decision, alternatives considered, rationale (create an ADR page too) |
| `review` | You review code or the project state | What you reviewed, findings, recommendations |
| `test` | You add or significantly modify tests | What was tested, coverage, any gaps found |
| `lint` | You run a project health check | Findings, fixes applied, open issues |
| `query` | You answer a question about the project | The question, answer, what pages you read to answer it |

## Checklist (verify before every response to user)
- [ ] Log entry written with correct action type and date
- [ ] Affected components/features linked as `[[wikilinks]]`
- [ ] If a new component/feature/decision was created, `open-foundry/docs/index.md` updated
- [ ] If a new component page was created, it has frontmatter and cross-references

## Anti-Patterns — Never Do These
1. **Ghost working** — Implementing without logging. If there's no log entry, it didn't happen.
2. **Logging without detail** — `implement | Built stuff` is useless. Say what, where, why.
3. **Orphan pages** — Creating a component page that no feature links to. Every page needs inbound links.
4. **Stale index** — Adding pages without updating `open-foundry/docs/index.md`. The index is the map.
5. **Missing cross-references** — Building a feature without linking to the components it uses.
6. **Silent plan drift** — Deviating from a plan without logging why. Plans change, but the change must be recorded.
7. **Unlogged decisions** — Making architectural choices without an ADR. If it affects the project's future, write it down.

## Session Start
At the start of every session:
1. Read `open-foundry/docs/index.md` — understand what exists
2. Read `open-foundry/docs/log.md` (last 5 entries) — understand recent activity

## Session End
At the end of every session:
1. Verify all actions are logged
2. Verify `open-foundry/docs/index.md` reflects current state
3. Update `last_updated` dates on any modified pages
