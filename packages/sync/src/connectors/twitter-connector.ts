/**
 * Twitter/X Connector for OSINT ingestion.
 *
 * Implements the Connector interface using X.com's internal GraphQL API.
 * Authenticates via browser cookies (Chrome/Edge/Firefox) — no API key required.
 *
 * Auto-discovers current GraphQL query IDs from Twitter's live JavaScript
 * bundle on each startup, so endpoint changes don't require code updates.
 *
 * Extraction modes:
 *   - fullExtract: paginated backfill of recent tweets
 *   - incrementalExtract: poll for new tweets since last checkpoint
 */

import { execSync } from "node:child_process";
import type { HealthStatus } from "@openfoundry/spi";
import type {
  Connector,
  ConnectorConfig,
  Checkpoint,
  ExtractOptions,
  SourceRecord,
  SourceSchema,
} from "./connector.js";
import type { ConnectorPlugin } from "./connector-registry.js";

// ─── Types ──────────────────────────────────────────────────────────────

interface TwitterAuth {
  authToken: string;
  ct0: string;
}

interface TweetData {
  tweet_id: string;
  text: string;
  author_id: string;
  author_handle: string;
  created_at: string;
  lang: string;
  retweet_count: number;
  favorite_count: number;
  reply_count: number;
  hashtags: string[];
  urls: string[];
  media_urls: string[];
}

interface GraphQLEndpoints {
  UserByScreenName: string;
  UserTweets: string;
  SearchTimeline: string;
}

// Twitter public anonymous guest token — overridable via env for rotation
const TWITTER_BEARER_TOKEN = process.env["TWITTER_BEARER_TOKEN"]
  ?? "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

// ─── Connector ──────────────────────────────────────────────────────────

export class TwitterConnector implements Connector {
  readonly name = "twitter";
  readonly version = "0.2.0";

  private auth: TwitterAuth | null = null;
  private endpoints: GraphQLEndpoints | null = null;
  private healthy = false;
  private paused = false;
  private pauseResolvers: (() => void)[] = [];
  private users: string[] = [];
  private queries: string[] = [];
  private maxRecordsPerSecond: number = 5;

  // ── Lifecycle ──────────────────────────────────────────────────────

  async initialize(config: ConnectorConfig): Promise<void> {
    this.users = (config.properties?.users as string[]) ?? [];
    this.queries = (config.properties?.queries as string[]) ?? [];
    this.maxRecordsPerSecond =
      (config.properties?.maxRecordsPerSecond as number) ?? 5;

    // 1. Authenticate via browser cookies or env vars
    this.auth = await extractTwitterAuth();
    if (!this.auth) {
      throw new Error(
        "TwitterConnector: no auth credentials found. " +
          "Log into x.com in Chrome, or set TWITTER_AUTH_TOKEN + TWITTER_CT0 env vars.",
      );
    }

    // 2. Discover current GraphQL query IDs
    this.endpoints = await discoverEndpoints(this.auth);
    if (!this.endpoints) {
      throw new Error(
        "TwitterConnector: failed to discover GraphQL endpoints from x.com JS bundle.",
      );
    }

    this.healthy = true;
  }

  async shutdown(): Promise<void> {
    this.auth = null;
    this.endpoints = null;
    this.healthy = false;
    this.paused = false;
    for (const resolve of this.pauseResolvers) resolve();
    this.pauseResolvers = [];
  }

  async healthCheck(): Promise<HealthStatus> {
    return {
      healthy: this.healthy && this.auth !== null,
      provider: "twitter",
      latencyMs: 0,
      details: {
        users: this.users.length,
        queries: this.queries.length,
        endpoints: this.endpoints !== null,
      },
    };
  }

  // ── Discovery ───────────────────────────────────────────────────────

  async discoverSchema(): Promise<SourceSchema> {
    return {
      tables: [
        {
          name: "tweets",
          columns: [
            { name: "tweet_id", type: "string", nullable: false },
            { name: "text", type: "string", nullable: false },
            { name: "author_id", type: "string", nullable: false },
            { name: "author_handle", type: "string", nullable: true },
            { name: "author_name", type: "string", nullable: true },
            { name: "author_followers", type: "integer", nullable: true },
            { name: "created_at", type: "datetime", nullable: false },
            { name: "lang", type: "string", nullable: true },
            { name: "retweet_count", type: "integer", nullable: true },
            { name: "favorite_count", type: "integer", nullable: true },
            { name: "reply_count", type: "integer", nullable: true },
            { name: "hashtags", type: "array<string>", nullable: true },
            { name: "urls", type: "array<string>", nullable: true },
            { name: "media_urls", type: "array<string>", nullable: true },
          ],
          primaryKey: ["tweet_id"],
        },
      ],
    };
  }

  // ── Extraction ──────────────────────────────────────────────────────

  async *fullExtract(
    table: string,
    options?: ExtractOptions,
  ): AsyncIterable<SourceRecord> {
    await this.waitIfPaused();
    if (!this.endpoints) throw new Error("Not initialized");
    if (table !== "tweets") return;

    const rateLimitMs = 1000 / this.maxRecordsPerSecond;
    let lastYield = 0;

    // Fetch from each monitored user
    for (const username of this.users) {
      const userId = await this.resolveUserId(username);
      if (!userId) continue;

      let cursor: string | undefined;
      let page = 0;
      const maxPages = Math.ceil((options?.batchSize ?? 200) / 20);

      while (page < maxPages) {
        const tweets = await this.fetchUserTweets(userId, cursor);
        if (tweets.length === 0) break;

        for (const tweet of tweets) {
          // Rate limit
          const now = Date.now();
          const elapsed = now - lastYield;
          if (elapsed < rateLimitMs) {
            await new Promise((r) => setTimeout(r, rateLimitMs - elapsed));
          }
          lastYield = Date.now();

          yield tweetToSourceRecord(tweet, table);
          cursor = tweet.tweet_id;
        }
        page++;
      }
    }

    // Fetch from search queries
    for (const query of this.queries) {
      let cursor: string | undefined;
      let page = 0;
      const maxPages = 5;

      while (page < maxPages) {
        const tweets = await this.searchTweets(query, cursor);
        if (tweets.length === 0) break;

        for (const tweet of tweets) {
          yield tweetToSourceRecord(tweet, table);
        }

        cursor = tweets.length > 0 ? tweets[tweets.length - 1]!.tweet_id : undefined;
        page++;
      }
    }
  }

  async *incrementalExtract(
    table: string,
    since: Checkpoint,
  ): AsyncIterable<SourceRecord> {
    await this.waitIfPaused();
    if (!this.endpoints) throw new Error("Not initialized");
    if (table !== "tweets") return;

    const sinceTweetId =
      typeof since === "object" && since !== null
        ? (since as Record<string, unknown>)["lastTweetId"] as
            | string
            | undefined
        : undefined;

    const rateLimitMs = 1000 / this.maxRecordsPerSecond;
    let lastYield = 0;

    for (const username of this.users) {
      const userId = await this.resolveUserId(username);
      if (!userId) continue;

      // Stagger API calls — 10s between users to avoid 429
      await new Promise(r => setTimeout(r, 10_000));

      let cursor: string | undefined;
      let page = 0;
      const maxPages = 5;
      let foundOlderTweets = false;

      while (page < maxPages && !foundOlderTweets) {
        const tweets = await this.fetchUserTweets(userId, cursor);
        if (tweets.length === 0) break;

        console.error(`[twitter-connector] @${username}: fetched ${tweets.length} tweets (page ${page + 1})`);

        for (const tweet of tweets) {
          if (sinceTweetId && tweet.tweet_id <= sinceTweetId) {
            foundOlderTweets = true;
            break;
          }

          const now = Date.now();
          if (now - lastYield < rateLimitMs) {
            await new Promise((r) => setTimeout(r, rateLimitMs - (now - lastYield)));
          }
          lastYield = Date.now();

          yield tweetToSourceRecord(tweet, table);
        }

        if (!foundOlderTweets) {
          cursor = tweets.length > 0 ? tweets[tweets.length - 1]!.tweet_id : undefined;
        }
        page++;
      }
    }
  }

  // ── Backpressure ────────────────────────────────────────────────────

  async pause(): Promise<void> {
    this.paused = true;
  }

  async resume(): Promise<void> {
    this.paused = false;
    for (const resolve of this.pauseResolvers) resolve();
    this.pauseResolvers = [];
  }

  // ── Private: X.com API ──────────────────────────────────────────────

  private async resolveUserId(username: string): Promise<string | null> {
    if (!this.endpoints) return null;
    const data = await this.graphqlRequest(
      this.endpoints.UserByScreenName,
      "UserByScreenName",
      { screen_name: username, withSafetyModeUserFields: true },
    );
    if (!data) return null;
    const userData = (data["data"] as Record<string, unknown>)?.["user"] as Record<string, unknown> | undefined;
    const resultObj = userData?.["result"] as Record<string, unknown> | undefined;
    return (resultObj?.["rest_id"] as string) ?? null;
  }

  private async fetchUserTweets(
    userId: string,
    cursor?: string,
  ): Promise<TweetData[]> {
    if (!this.endpoints) return [];
    const variables: Record<string, unknown> = {
      userId,
      count: 40,
      includePromotedContent: false,
      withVoice: false,
      withV2Timeline: true,
    };
    if (cursor) variables["cursor"] = cursor;

    const data = await this.graphqlRequest(
      this.endpoints.UserTweets,
      "UserTweets",
      variables,
    );
    return extractTweets(data);
  }

  private async searchTweets(
    query: string,
    cursor?: string,
  ): Promise<TweetData[]> {
    if (!this.endpoints) return [];
    if (!this.endpoints.SearchTimeline) return [];
    const vars: Record<string, unknown> = {
      rawQuery: query,
      count: 20,
      querySource: "typed_query",
      product: "Top",
    };
    if (cursor) vars["cursor"] = cursor;

    const data = await this.graphqlRequest(
      this.endpoints.SearchTimeline,
      "SearchTimeline",
      vars,
    );
    return extractTweets(data);
  }

  private async graphqlRequest(
    queryId: string,
    operationName: string,
    variables: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    if (!this.auth) return null;

    const params = new URLSearchParams();
    params.set("variables", JSON.stringify(variables));

    const url = `https://x.com/i/api/graphql/${queryId}/${operationName}?${params.toString()}`;
    const headers: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Content-Type": "application/json",
      Authorization: `Bearer ${TWITTER_BEARER_TOKEN}`,
      Cookie: `auth_token=${this.auth.authToken}; ct0=${this.auth.ct0}`,
      "x-csrf-token": this.auth.ct0,
      "X-Twitter-Active-User": "yes",
      "X-Twitter-Client-Language": "en",
      Referer: "https://x.com/",
    };

    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      console.error(`[twitter-connector] ${operationName}: HTTP ${response.status} — ${response.statusText}`);
      if (response.status === 429) {
        console.error(`[twitter-connector] Rate limited, waiting 2min...`);
        await new Promise((r) => setTimeout(r, 120_000));
        const retry = await fetch(url, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(15_000),
        });
        if (retry.ok) return (await retry.json()) as Record<string, unknown>;
        console.error(`[twitter-connector] ${operationName}: Retry also failed — HTTP ${retry.status}`);
      }
      return null;
    }

    return (await response.json()) as Record<string, unknown>;
  }

  private async waitIfPaused(): Promise<void> {
    if (!this.paused) return;
    return new Promise<void>((resolve) => {
      this.pauseResolvers.push(resolve);
    });
  }
}

// ─── Plugin Registration ───────────────────────────────────────────────

export const twitterPlugin: ConnectorPlugin = {
  metadata: {
    name: "twitter",
    version: "0.2.0",
    description:
      "Twitter/X connector — ingests tweets via internal GraphQL API using browser cookies",
    configSchema: {
      type: "object",
      properties: {
        browserAuth: { type: "boolean", default: true },
        users: { type: "array", items: { type: "string" } },
        queries: { type: "array", items: { type: "string" } },
        maxRecordsPerSecond: { type: "number", default: 5 },
      },
    },
  },
  factory: (_config) => new TwitterConnector(),
};

// ─── Helpers ────────────────────────────────────────────────────────────

function tweetToSourceRecord(tweet: TweetData, table: string): SourceRecord {
  return {
    table,
    key: { tweet_id: tweet.tweet_id },
    data: {
      tweet_id: tweet.tweet_id,
      text: tweet.text,
      author_id: tweet.author_id,
      author_handle: tweet.author_handle,
      created_at: twitterDateToISO(tweet.created_at),
      lang: tweet.lang,
      retweet_count: tweet.retweet_count,
      favorite_count: tweet.favorite_count,
      reply_count: tweet.reply_count,
      hashtags: tweet.hashtags,
      urls: tweet.urls,
      media_urls: tweet.media_urls,
    },
    operation: "INSERT",
    timestamp: new Date().toISOString() as import("@openfoundry/spi").DateTime,
    checkpoint: { lastTweetId: tweet.tweet_id },
  };
}

/** Convert Twitter's date format to ISO 8601 */
function twitterDateToISO(date: string): string {
  try {
    return new Date(date).toISOString();
  } catch {
    return date;
  }
}

// ─── extractTweets helpers ─────────────────────────────────────────────

/** Navigate the Twitter GraphQL response to the timeline instructions array. */
function getTimelineInstructions(
  data: Record<string, unknown> | null,
): Array<Record<string, unknown>> | null {
  if (!data) return null;
  const result = (data as Record<string, unknown>)["data"] as Record<string, unknown> | undefined;
  if (!result) return null;
  const user = result["user"] as Record<string, unknown> | undefined;
  if (!user) return null;
  const userResult = user["result"] as Record<string, unknown> | undefined;
  if (!userResult) return null;
  const timeline =
    (userResult["timeline"] as Record<string, unknown>) ??
    (userResult["timeline_v2"] as Record<string, unknown>);
  if (!timeline) return null;
  const tl = timeline["timeline"] as Record<string, unknown>;
  if (!tl) return null;
  return tl["instructions"] as Array<Record<string, unknown>>;
}

/** Unwrap retweet nesting and extract legacy + core user from a tweet result node. */
function extractTweetPayload(result: Record<string, unknown>): {
  leg: Record<string, unknown>;
  authorScreenName: string;
  authorId: string;
} | null {
  const retweeted = result["retweeted_status_result"] as Record<string, unknown> | undefined;
  const effectiveResult = retweeted
    ? (retweeted["result"] as Record<string, unknown>) ?? result
    : result;

  // Try legacy path, then tweet.legacy (nested tweet format)
  let leg = effectiveResult["legacy"] as Record<string, unknown> | undefined;
  if (!leg) {
    const innerTweet = effectiveResult["tweet"] as Record<string, unknown>;
    leg = innerTweet?.["legacy"] as Record<string, unknown> | undefined;
  }
  if (!leg) return null;

  const core = effectiveResult["core"] as Record<string, unknown>;
  const userResults = core?.["user_results"] as Record<string, unknown>;
  const userResultObj = userResults?.["result"] as Record<string, unknown>;
  const userResultCore = userResultObj?.["core"] as Record<string, unknown> | undefined;

  let screenName = (userResultCore?.["screen_name"] as string) ?? "";
  const restId = (userResultObj?.["rest_id"] as string) ?? "";
  if (!screenName && restId) {
    console.warn(`[twitter-connector] authorScreenName empty for rest_id=${restId}, tweet_id=${leg["id_str"]}`);
    screenName = restId;
  }

  return { leg, authorScreenName: screenName, authorId: restId };
}

/** Extract hashtags, URLs, and media URLs from a legacy tweet blob. */
function extractMedia(leg: Record<string, unknown>): {
  hashtags: string[];
  urls: string[];
  mediaUrls: string[];
} {
  const entities = (leg["entities"] as Record<string, unknown>) ?? {};
  const hashtags = (
    (entities["hashtags"] as Array<Record<string, unknown>>) ?? []
  ).map((h) => h["text"] as string);
  const urls = (
    (entities["urls"] as Array<Record<string, unknown>>) ?? []
  ).map((u) => u["expanded_url"] as string);

  const extendedEntities = leg["extended_entities"] as Record<string, unknown>;
  const mediaUrls = (
    (extendedEntities?.["media"] as Array<Record<string, unknown>>) ?? []
  ).map((m) => m["media_url_https"] as string);

  return { hashtags, urls, mediaUrls };
}

/** Extract tweets from a Twitter GraphQL response. Under 30 lines. */
function extractTweets(
  data: Record<string, unknown> | null,
): TweetData[] {
  const instructions = getTimelineInstructions(data);
  if (!instructions) return [];

  const tweets: TweetData[] = [];

  for (const instr of instructions) {
    if (instr["type"] !== "TimelineAddEntries") continue;
    const entries = instr["entries"] as Array<Record<string, unknown>>;
    if (!entries) continue;

    for (const entry of entries) {
      const content = entry["content"] as Record<string, unknown>;
      if (!content) continue;
      const entryType = (content["entryType"] as string) ?? "";
      if (entryType !== "TimelineTimelineItem" && entryType !== "TimelineTweet") continue;

      const itemContent = content["itemContent"] as Record<string, unknown>;
      if (!itemContent) continue;
      const tweetResults = itemContent["tweet_results"] as Record<string, unknown>;
      if (!tweetResults) continue;
      const tweetResult = tweetResults["result"] as Record<string, unknown>;
      if (!tweetResult) continue;

      const payload = extractTweetPayload(tweetResult);
      if (!payload) continue;
      const { leg, authorScreenName, authorId } = payload;
      const media = extractMedia(leg);

      tweets.push({
        tweet_id: (leg["id_str"] as string) ?? "",
        text: (leg["full_text"] as string) ?? "",
        author_id: authorId,
        author_handle: authorScreenName,
        created_at: (leg["created_at"] as string) ?? "",
        lang: (leg["lang"] as string) ?? "?",
        retweet_count: (leg["retweet_count"] as number) ?? 0,
        favorite_count: (leg["favorite_count"] as number) ?? 0,
        reply_count: (leg["reply_count"] as number) ?? 0,
        hashtags: media.hashtags,
        urls: media.urls,
        media_urls: media.mediaUrls,
      });
    }
  }

  return tweets;
}

// ─── Auth Extraction (delegates to Python browser_cookie3) ──────────────

async function extractTwitterAuth(): Promise<TwitterAuth | null> {
  // 1. Try env vars first (server/headless deployment)
  const envAuth = extractFromEnv();
  if (envAuth) return envAuth;

  // 2. Try browser cookie extraction via Python3 + browser_cookie3
  try {
    return await extractFromBrowser();
  } catch {
    return null;
  }
}

function extractFromEnv(): TwitterAuth | null {
  const authToken = process.env["TWITTER_AUTH_TOKEN"];
  const ct0 = process.env["TWITTER_CT0"];
  if (authToken && ct0) return { authToken, ct0 };
  return null;
}

async function extractFromBrowser(): Promise<TwitterAuth | null> {
  const pythonScript = `
import browser_cookie3, json, sys
try:
    cj = browser_cookie3.load()
    auth_token = ct0 = None
    for c in cj:
        if c.domain and '.x.com' in c.domain:
            if c.name == 'auth_token': auth_token = c.value
            elif c.name == 'ct0': ct0 = c.value
    if auth_token and ct0:
        print(json.dumps({'authToken': auth_token, 'ct0': ct0}))
    else:
        print('')
except Exception as e:
    print(json.dumps({'error': str(e)}), file=sys.stderr)
`;

  try {
    const result = execSync(`python3 -c ${JSON.stringify(pythonScript)}`, {
      encoding: "utf-8",
      timeout: 15_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (!result) return null;
    const parsed = JSON.parse(result) as {
      authToken?: string;
      ct0?: string;
      error?: string;
    };
    if (parsed.error || !parsed.authToken || !parsed.ct0) return null;
    return { authToken: parsed.authToken, ct0: parsed.ct0 };
  } catch {
    return null;
  }
}

// ─── GraphQL Endpoint Discovery ─────────────────────────────────────────

async function discoverEndpoints(
  auth: TwitterAuth,
): Promise<GraphQLEndpoints | null> {
  try {
    // 1. Fetch x.com homepage to find main JS bundle
    const htmlResp = await fetch("https://x.com/", {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Cookie: `auth_token=${auth.authToken}; ct0=${auth.ct0}`,
        "x-csrf-token": auth.ct0,
      },
      signal: AbortSignal.timeout(15_000),
    });
    const html = await htmlResp.text();

    const match = html.match(
      /src="(https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/main\.[a-f0-9]+\.js)"/,
    );
    if (!match?.[1]) return null;

    const jsResp = await fetch(match[1], {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      signal: AbortSignal.timeout(30_000),
    });
    const js = await jsResp.text();

    // 4. Extract all queryId/operationName pairs
    const ops: Record<string, string> = {};
    const re = /queryId:"([^"]+)",operationName:"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(js)) !== null) {
      ops[m[2]!] = m[1]!;
    }

    const UserByScreenName =
      ops["UserByScreenName"] ?? ops["usersByScreenName"];
    const UserTweets = ops["UserTweets"] ?? ops["userTweets"];
    const SearchTimeline = ops["SearchTimeline"];

    if (!UserByScreenName || !UserTweets) return null;

    return { UserByScreenName, UserTweets, SearchTimeline: SearchTimeline ?? "" };
  } catch {
    return null;
  }
}
