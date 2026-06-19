/**
 * Live NER test: fetches real tweets via Twitter connector, runs entity extraction,
 * and prints extracted Person/Organization/Location/Equipment entities.
 *
 * Usage:
 *   cd open-foundry && npx tsx tools/test-ner-live.ts
 */

import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Load env vars from deploy/.env manually (avoid dotenv dependency)
function loadEnv(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  const content = readFileSync(path, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

async function main() {
  console.log('=== NER Live Test — Real Tweets from X.com ===\n');

  const envPath = resolve(import.meta.dirname, '..', 'deploy', '.env');
  const env = loadEnv(envPath);

  const authToken = env['TWITTER_AUTH_TOKEN'];
  const ct0 = env['TWITTER_CT0'];

  if (!authToken || !ct0) {
    console.error('ERROR: TWITTER_AUTH_TOKEN and TWITTER_CT0 must be in deploy/.env');
    process.exit(1);
  }

  process.env['TWITTER_AUTH_TOKEN'] = authToken;
  process.env['TWITTER_CT0'] = ct0;

  // ── 1. Twitter Connector: fetch tweets ──
  console.log('Initializing Twitter connector...');
  const { TwitterConnector } = await import(
    '../packages/sync/dist/connectors/twitter-connector.js'
  );

  const connector = new TwitterConnector();
  await connector.initialize({
    url: 'https://x.com/i/api/graphql',
    table: 'tweets',
    properties: {
      browserAuth: false,
      users: ['sentdefender'],
      queries: [],
    },
  } as any);

  console.log('Fetching recent tweets from @sentdefender...');
  const recordStream = connector.incrementalExtract('tweets', '');
  const records: any[] = [];
  let i = 0;
  for await (const rec of recordStream) {
    records.push(rec);
    i++;
    if (i >= 15) break;
  }

  console.log(`Fetched ${records.length} tweets.\n`);

  // ── 2. Entity Extraction ──
  const { WinkExtractor, GazetteerExtractor, CompositeExtractor } = await import(
    '../packages/sync/dist/entity-extraction/index.js'
  );

  const extractors: any[] = [new WinkExtractor(0.6)];

  const gazetteerPath = resolve(
    import.meta.dirname, '..',
    'domain-packs/osint/entity-extraction/equipment-gazetteer.yaml',
  );
  try {
    const g = new GazetteerExtractor(gazetteerPath);
    extractors.push(g);
    console.log('Equipment gazetteer loaded (80 entries).\n');
  } catch {
    console.log('Equipment gazetteer not found, skipping equipment extraction.\n');
  }

  const composite = new CompositeExtractor(extractors);

  // ── 3. Process each tweet ──
  let totalPersons = 0;
  let totalOrgs = 0;
  let totalLocs = 0;
  let totalEquipment = 0;
  let tweetCount = 0;
  let noEntityCount = 0;

  for (const rec of records) {
    const data = rec.data as Record<string, any> | undefined;
    const content: string = data?.text ?? data?.full_text ?? '';
    const author: string = data?.author_handle ?? data?.user_screen_name ?? 'unknown';

    if (!content?.trim()) continue;
    tweetCount++;

    const displayContent = content.length > 250 ? content.slice(0, 250) + '...' : content;
    console.log(`── Tweet ${tweetCount} (@${author}) ──`);
    console.log(`${displayContent}`);

    const entities = await composite.extract(content);
    const persons = entities.filter((e: any) => e.type === 'Person');
    const orgs = entities.filter((e: any) => e.type === 'Organization');
    const locs = entities.filter((e: any) => e.type === 'Location');
    const equip = entities.filter((e: any) => e.type === 'Equipment');

    totalPersons += persons.length;
    totalOrgs += orgs.length;
    totalLocs += locs.length;
    totalEquipment += equip.length;
    if (entities.length === 0) noEntityCount++;

    if (persons.length) console.log(`  Person:        ${persons.map((p: any) => p.name).join(', ')}`);
    if (orgs.length) console.log(`  Organization:  ${orgs.map((o: any) => o.name).join(', ')}`);
    if (locs.length) console.log(`  Location:      ${locs.map((l: any) => l.name).join(', ')}`);
    if (equip.length) console.log(`  Equipment:     ${equip.map((e: any) => e.name).join(', ')}`);
    if (entities.length === 0) console.log('  → (no entities extracted)');
    console.log();
  }

  console.log('═══════════════════════════════════════════');
  console.log(`Results: ${tweetCount} tweets processed`);
  console.log(`  Persons extracted:       ${totalPersons}`);
  console.log(`  Organizations extracted: ${totalOrgs}`);
  console.log(`  Locations extracted:     ${totalLocs}`);
  console.log(`  Equipment extracted:     ${totalEquipment}`);
  console.log(`  Total entities:          ${totalPersons + totalOrgs + totalLocs + totalEquipment}`);
  console.log(`  Tweets with no entities: ${noEntityCount}/${tweetCount}`);
  console.log('═══════════════════════════════════════════');

  await connector.shutdown();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
