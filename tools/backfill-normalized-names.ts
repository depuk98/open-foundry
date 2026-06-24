/**
 * One-shot backfill script: populate _normalized_name for existing entities.
 *
 * Reads all rows from person, organization, location, equipment, event tables,
 * computes normalizeForDedup() for each, and updates the _normalized_name column.
 * Idempotent — running twice produces identical results.
 *
 * Usage: npx tsx tools/backfill-normalized-names.ts
 */

import { Pool } from 'pg';
import { normalizeForDedup } from '../packages/sync/src/entity-extraction/dedup-utils.js';

const pool = new Pool({
  host: process.env['POSTGRES_HOST'] ?? 'localhost',
  port: parseInt(process.env['POSTGRES_PORT'] ?? '5432', 10),
  database: process.env['POSTGRES_DB'] ?? 'openfoundry',
  user: process.env['POSTGRES_USER'] ?? 'openfoundry',
  password: process.env['POSTGRES_PASSWORD'] ?? '',
});

interface TableConfig {
  table: string;
  nameField: string;
  type: string;
}

const TABLES: TableConfig[] = [
  { table: 'person', nameField: 'full_name', type: 'Person' },
  { table: 'organization', nameField: 'name', type: 'Organization' },
  { table: 'location', nameField: 'name', type: 'Location' },
  { table: 'equipment', nameField: 'designation', type: 'Equipment' },
  { table: 'intel_event', nameField: 'description', type: 'Event' },
];

async function main() {
  console.log('Backfilling _normalized_name for all entity tables...');

  for (const tc of TABLES) {
    // Count rows needing backfill
    const countResult = await pool.query(
      `SELECT COUNT(*) as cnt FROM public.${tc.table}
       WHERE _normalized_name IS NULL AND _deleted_at IS NULL`,
    );
    const count = parseInt(countResult.rows[0]?.cnt ?? '0', 10);
    if (count === 0) {
      console.log(`  ${tc.table}: 0 rows need backfill (already up to date)`);
      continue;
    }
    console.log(`  ${tc.table}: ${count} rows need backfill`);

    // Fetch rows
    const rows = await pool.query(
      `SELECT "_id", "${tc.nameField}" FROM public.${tc.table}
       WHERE _normalized_name IS NULL AND _deleted_at IS NULL`,
    );

    let updated = 0;
    for (const row of rows.rows) {
      const rawName = row[tc.nameField] as string;
      if (!rawName) continue;

      const normalized = normalizeForDedup(tc.type, rawName);
      if (!normalized) continue;

      await pool.query(
        `UPDATE public.${tc.table} SET _normalized_name = $1 WHERE "_id" = $2`,
        [normalized, row['_id']],
      );
      updated++;
    }
    console.log(`  ${tc.table}: updated ${updated} rows`);
  }

  await pool.end();
  console.log('Backfill complete.');
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
