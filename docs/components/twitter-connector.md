---
title: Twitter Connector
created: 2026-06-17
last_updated: 2026-06-18
type: component
package: "@openfoundry/sync"
status: active
related_components:
  - sync-engine
  - api-gateway
  - ontology-engine
---

# Twitter Connector

A `Connector` implementation for X.com's internal GraphQL API. Uses browser cookie authentication (no API key required) and auto-discovers current GraphQL query IDs from Twitter's live JavaScript bundle. Supports paginated backfill extraction and incremental polling with checkpoint-based resumption.

## Public API

- **`TwitterConnector`** — Implements the `Connector` interface (`name: "twitter"`, `version: "0.2.0"`)
- **`twitterPlugin`** — `ConnectorPlugin` factory for `ConnectorRegistry` registration
- Key methods: `initialize()`, `fullExtract()`, `incrementalExtract()`, `healthCheck()`, `pause()`, `resume()`, `discoverSchema()`

## How It Works

### Authentication

Zero-config browser cookie extraction via Python `browser_cookie3`. On initialize, the connector:
1. Calls `extractFromEnv()` to check `TWITTER_AUTH_TOKEN` / `TWITTER_CT0` env vars (headless Docker)
2. Falls back to `extractFromBrowser()` which shells out to `python3 -c "import browser_cookie3..."` to read Chrome/Firefox/Edge cookie stores
3. Decrypts encrypted cookies using the OS keychain (macOS Keychain, Linux libsecret, Windows DPAPI)

### Endpoint Discovery

On every startup, the connector auto-discovers current GraphQL query IDs:
1. Fetches `https://x.com/` homepage
2. Extracts the `main.{hash}.js` URL from HTML
3. Downloads and parses the ~1.4MB JS bundle
4. Extracts all `queryId:"...",operationName:"..."` pairs (~157 operations)
5. Resolves `UserByScreenName`, `UserTweets`, `SearchTimeline` IDs

### Extraction

- **`fullExtract`**: paginated backfill with configurable batch size
- **`incrementalExtract`**: polls for tweets newer than checkpoint `lastTweetId`
- For each monitored user: resolves user ID → fetches tweets → yields `SourceRecord`
- For each search query: searches via `SearchTimeline` → yields matching tweets
- Internal rate limiting with configurable delays between users
- HTTP 429 handling with 5-minute cooldown and retry

### Tweet Parsing

Handles Twitter's complex API response structure:
- Non-retweets: extracts `full_text`, `screen_name` from `result.core.screen_name`
- Retweets: resolves `retweeted_status_result` to get original tweet's content and author
- Extracts hashtags, URLs, media URLs, language, engagement metrics
- Normalizes dates from `"EEE MMM dd HH:mm:ss Z yyyy"` to ISO 8601

## Dependencies

- **Runtime**: Python 3 + `browser-cookie3` (for cookie decryption)
- **Internal**: `@openfoundry/spi` (types), `@openfoundry/observability`
- **External**: X.com internal GraphQL API (undocumented, reverse-engineered)

## Used By

- [[osint-domain-pack]] — primary ingestion connector for geopolitical OSINT feeds
- [[api-gateway]] — connector lifecycle managed by server.ts connector wiring

## Key Design Decisions

- [[adr-009-twitter-internal-api]] — Why use Twitter's internal GraphQL API instead of the official X API v2
- Uses browser cookies for zero-config auth (same approach as agent-reach's twitter-cli)
- Auto-discovers query IDs to survive Twitter's frequent endpoint changes
- 5-minute extraction interval with staggered user fetches to avoid rate limiting

## Current Limitations

- Polling only (no streaming endpoint on internal API)
- Query IDs may change between Twitter releases
- Requires logged-in x.com session (or env var fallback for headless)
- No automated NER extraction from tweet text (planned — see [[osint-domain-pack]] roadmap)

## Sources

- File: `packages/sync/src/connectors/twitter-connector.ts` — 640 lines
- Registered in: `packages/sync/src/connectors/default-registry.ts`
- Config: `domain-packs/osint/connectors/twitter-osint.yaml`
- Auth utility: `domain-packs/osint/src/browser-cookies.ts`
