---
title: ADR-009 — Twitter Internal GraphQL API vs Official X API v2
created: 2026-06-17
type: decision
status: accepted
related_components:
  - twitter-connector
  - sync-engine
related_features:
  - osint-domain-pack
---

# ADR-009: Use Twitter's Internal GraphQL API Instead of Official X API v2

## Context

The OSINT domain pack needs to ingest tweets from 15+ geopolitical OSINT accounts (sentdefender, TheStudyofWar, bellingcat, etc.) every few minutes. We needed an authentication and data access strategy for the Twitter/X connector.

## Decision

Use Twitter's **internal GraphQL API** (the same endpoints the Twitter web app uses) via browser cookie authentication, instead of the official X API v2.

## Alternatives Considered

### Alternative A: Official X API v2 (Rejected)
- **Pros**: Documented, stable, official support
- **Cons**: Requires paid tier ($100-$5,000/month), rate-limited to 500k tweets/month (Basic) or 1M (Pro), requires developer account approval, limited to 7-day search window on Basic tier, OAuth 2.0 setup complexity
- **Why rejected**: Cost-prohibitive for an open-source project. Rate limits too restrictive for 15 accounts polling every few minutes.

### Alternative B: Twitter CLI scraping (Rejected)
- **Pros**: Well-established (twitter-cli, snscrape), handles auth and endpoint discovery
- **Cons**: External Python dependency, separate process management, fragile regex-based parsing
- **Why rejected**: Wanted a TypeScript-native implementation integrated into the Connector interface for proper lifecycle management (pause/resume, health checks, checkpointing).

### Alternative C: Internal GraphQL API via browser cookies (Chosen)
- **Pros**: Zero cost, no API keys, full search access, generous rate limits (per-user, not per-app), auto-discovers current endpoints from JS bundle
- **Cons**: Undocumented API, endpoints change without notice, requires logged-in browser session, HTTP 429 handling needed
- **Why chosen**: Best fit for an open-source OSINT tool. The endpoint auto-discovery mitigates the undocumented API risk. The connector handles 429 with exponential backoff.

## Consequences

### What becomes easier
- Zero-cost OSINT ingestion for any researcher with a Twitter account
- Full tweet content access (no 7-day window limitation)
- Self-healing endpoint discovery survives Twitter's frequent changes
- Works with the Connector interface (pause/resume, health checks, checkpointing)

### What becomes harder
- Cannot stream tweets (polling only — internal API has no streaming endpoint)
- Must handle HTTP 429 rate limiting carefully (5-min cooldown, staggered fetches)
- Query ID discovery adds ~2s to startup time
- Browser cookie dependency means headless deployments need env var fallback
- Maintenance burden when Twitter changes API response structure (e.g., `screen_name` path changed from `result.legacy` to `result.core` in June 2026)

## Sources

- `packages/sync/src/connectors/twitter-connector.ts` — Implementation
- agent-reach's twitter-cli — Reference for internal API approach
