import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, unlinkSync } from 'node:fs';
import { GazetteerExtractor } from '../gazetteer-extractor.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpGazetteer = join(tmpdir(), 'test-equipment-gazetteer.yaml');
writeFileSync(tmpGazetteer, `
equipment:
  - designation: "T-90M"
    aliases: ["T-90", "T90"]
    category: MAIN_BATTLE_TANK
  - designation: "HIMARS"
    aliases: []
    category: MULTIPLE_ROCKET_LAUNCHER
  - designation: "Bayraktar TB2"
    aliases: ["TB2", "Bayraktar"]
    category: DRONE
`);

const extractor = new GazetteerExtractor(tmpGazetteer);

describe('GazetteerExtractor', () => {
  it('matches exact equipment name', async () => {
    const result = await extractor.extract('Russian T-90M tanks spotted near the border.');
    expect(result.some((e) => e.name === 'T-90M')).toBe(true);
  });

  it('matches via alias', async () => {
    const result = await extractor.extract('Multiple T90 units deployed to the front.');
    expect(result.some((e) => e.name === 'T-90M')).toBe(true);
  });

  it('matches case-insensitively', async () => {
    const result = await extractor.extract('HIMARS strike confirmed by Ukrainian forces.');
    expect(result.some((e) => e.name === 'HIMARS')).toBe(true);
  });

  it('deduplicates when multiple aliases match', async () => {
    const result = await extractor.extract('Bayraktar TB2 and TB2 drones spotted.');
    const matches = result.filter((e) => e.name === 'Bayraktar TB2');
    expect(matches.length).toBe(1);
  });

  it('returns empty for text with no equipment', async () => {
    const result = await extractor.extract('Diplomatic talks continue in Geneva.');
    expect(result).toEqual([]);
  });

  it('returns empty for empty text', async () => {
    const result = await extractor.extract('');
    expect(result).toEqual([]);
  });

  it('does not match partial words', async () => {
    const result = await extractor.extract('The T900 is a fictional tank.');
    expect(result.filter((e) => e.name === 'T-90M').length).toBe(0);
  });
});

afterAll(() => {
  try { unlinkSync(tmpGazetteer); } catch { /* cleanup */ }
});
