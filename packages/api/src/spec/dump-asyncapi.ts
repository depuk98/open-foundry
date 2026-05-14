/**
 * CLI: dump the generated AsyncAPI 2.6.0 spec to a file.
 *
 * Usage:
 *   node dist/spec/dump-asyncapi.js <output-path>
 *
 * Writes JSON by default. If the output path ends in .yaml or .yml,
 * writes YAML instead.
 */

import { writeFileSync } from 'node:fs';
import { stringify as yamlStringify } from 'yaml';
import { loadDomainPacks } from '../schema-loader.js';
import { generateAsyncApiSpec } from './asyncapi-generator.js';

async function main(): Promise<void> {
  const output = process.argv[2];
  if (!output) {
    console.error('Usage: dump-asyncapi <output-path>');
    process.exit(1);
  }

  const { parsed } = await loadDomainPacks();
  const spec = generateAsyncApiSpec(parsed);

  const content = output.endsWith('.yaml') || output.endsWith('.yml')
    ? yamlStringify(spec, { lineWidth: 120 })
    : JSON.stringify(spec, null, 2);

  writeFileSync(output, content, 'utf-8');
  console.log(`AsyncAPI 2.6.0 spec written to ${output}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
