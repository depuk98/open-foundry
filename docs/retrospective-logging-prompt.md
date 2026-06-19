# Corrective Logging Prompt — Log YOUR Delta, Keep Baseline Docs

> Copy-paste this into the SAME LLM session where you built your additions on top of OpenFoundry.
> The session already has context of everything you asked it to build. Use that context.
> 
> **This replaces the previous prompt.** The previous prompt was wrong — it logged the original author's work into `log.md`. This one fixes that.

---

## CRITICAL: Baseline vs. Delta

The OpenFoundry repo you cloned is the **BASELINE**. The 36 pages already created in `docs/components/`, `docs/features/`, `docs/decisions/`, `docs/concepts/`, `docs/syntheses/` are **useful codebase documentation** — they describe what exists. Keep them. They serve as reference for anyone (including future LLMs) working on this codebase.

The distinction is:

| What | Contains | Baseline goes here? | Your delta goes here? |
|------|----------|---------------------|----------------------|
| `docs/components/` etc. | WHAT exists (documentation) | Yes — useful reference | Yes — add your new pages |
| `docs/index.md` | Catalog of everything | Yes — it's a map of the codebase | Yes — add your entries |
| `docs/log.md` | WHO did WHAT and WHEN | **NO** — only your actions | **YES** — only your actions |

**`log.md` is the activity record of YOUR work. It is not a history of the repo.**

## STEP 0 — Read AGENTS.md

Read `AGENTS.md`. This defines the logging protocol, page conventions, and directory structure.

## STEP 1 — Identify your delta

Your delta is what YOU built in this session on top of the cloned baseline. Use your session context — you already know what you were asked to build. Do NOT derive this from git log.

At minimum, your delta includes these uncommitted/untracked files (verify with `git status`):

- `domain-packs/osint/` — Entire OSINT domain pack you built
- `packages/sync/src/connectors/twitter-connector.ts` — Twitter/X connector
- `packages/api/src/server.ts` — API server changes (+164 lines)
- `packages/sync/src/connectors/default-registry.ts` — Connector registry updates
- `packages/sync/src/connectors/index.ts` — New exports
- `packages/sync/src/index.ts` — Re-exports
- `deploy/docker-compose.yaml` — Config changes

But also use your SESSION MEMORY. You know:
- What the user asked you to plan
- What plans you created
- What you implemented
- What decisions you made along the way
- Any concepts or patterns you introduced

## STEP 2 — Create NEW pages for your contributions

Add your pages alongside the existing baseline pages. Do NOT delete the baseline pages.

### New feature pages (`docs/features/`)
- `osint-domain-pack.md` — The OSINT domain pack you built (10 object types: IntelReport, SourceProfile, Person, Organization, Location, Event, Equipment, Assessment, Indicator, Narrative; 7 actions: Corroborate, Contradict, Escalate, CreateAssessment, GeoVerify, FlagDisinformation, AssignCredibility; 4 connectors: Twitter, Telegram, ISW RSS, ACLED API)
- Any other feature you built or significantly extended

### New component pages (`docs/components/`)
- `twitter-connector.md` — The Twitter/X connector you built (~645 lines, uses X.com internal GraphQL API via browser cookies, supports paginated backfill + incremental polling, auto-discovers query IDs from Twitter's JS bundle)
- Any other new components you introduced

### New decision pages (`docs/decisions/`)
Create ADRs for architectural decisions YOU made. Number them continuing from the existing ADRs (start at adr-009 or whatever comes next):
- Why you chose Twitter's internal GraphQL API over the official API
- Why you structured the OSINT domain pack the way you did
- Any connector design decisions
- Any other choices you made during implementation

### New concept pages (`docs/concepts/`)
Create pages for patterns YOU introduced:
- The connector pattern as you implemented it (if different from existing)
- The OSINT data model design
- Any new patterns you established

### New synthesis pages (`docs/syntheses/`)
Create if you have enough of your content to synthesize:
- How your Twitter connector fits into the sync engine's connector architecture
- The OSINT domain pack's integration flow

## STEP 3 — Add YOUR pages to the index

Update `docs/index.md` — add your new pages to the existing catalog. Keep all the baseline entries. Your additions go into each section:

- **Components**: Add `[[twitter-connector]]` and any other new component pages
- **Features**: Add `[[osint-domain-pack]]` (status: in-progress)
- **Decisions**: Add any new ADRs you create
- **Concepts**: Add any new concept pages
- **Syntheses**: Add any new synthesis pages

Update the Meta section counts accordingly.

## STEP 4 — Populate `docs/log.md` with YOUR actions ONLY

**This is the critical step.** `docs/log.md` is the activity record of YOUR work on this project. It starts blank (or with only a stub). Do NOT put the original repo's git history in here.

The log should start with:
```
## [2026-06-17] baseline | Cloned OpenFoundry repo as starting point
Repository cloned from syzygyhack/open-foundry. This is the immutable baseline. All subsequent entries document additions made on top.
```

Then log EVERY action you took in this session, chronologically. Use your session memory.

Ask yourself:
- What was the first thing the user asked me to do?
- Did I create a plan? → `plan` entry
- Did I implement something? → `implement` entry  
- Did I integrate a connector? → `integrate` entry
- Did I make design decisions? → `decide` entry
- Did I debug anything? → `debug` entry

Format each entry as:
```
## [2026-06-18] action-type | Short description
Details about what was done, what files were touched, why.
Components: [[component-you-touched]]
Features: [[feature-you-built]]
```

Be specific — use filenames, describe what was built, explain why. Every bullet should be traceable to a file or a decision you made.

## STEP 5 — Cross-reference your new pages

- Link your OSINT feature page to the components it touches ([[sync-engine]], [[api-gateway]], [[twitter-connector]])
- Link your Twitter connector page to the feature it serves ([[osint-domain-pack]]) and the existing connector pattern page
- Link your new ADRs to affected components and features
- Add backlinks from existing baseline pages to your new pages where relevant (e.g., from [[sync-engine]] to [[twitter-connector]])
- Ensure no orphan pages among your additions

## STEP 6 — Verify

- [ ] `docs/log.md` contains only YOUR actions (starts with the baseline entry, then your session actions). Zero entries from the original repo's git history.
- [ ] `docs/index.md` lists both baseline pages AND your new pages. Counts are updated.
- [ ] Your new pages have proper frontmatter with `type`, `status`, `created` date
- [ ] Cross-references are bidirectional
- [ ] No orphan pages among your additions

Then append the final log entry:
```
## [2026-06-18] init | Delta logging complete — your contributions catalogued
Logged N features, N components, N decisions, N concepts built on top of the OpenFoundry baseline.
Existing codebase documentation (36 pages) retained as reference. Log contains only your actions.
```
