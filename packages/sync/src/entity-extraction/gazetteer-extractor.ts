import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { EntityExtractor, ExtractedEntity } from './types.js';

interface GazetteerEntry {
  designation: string;
  aliases?: string[];
  category?: string;
}

interface GazetteerFile {
  equipment: GazetteerEntry[];
}

/**
 * Equipment gazetteer extractor — matches military equipment names
 * against a curated YAML list. Case-insensitive word-boundary matching.
 */
export class GazetteerExtractor implements EntityExtractor {
  readonly name = 'gazetteer-equipment';
  private patterns: Array<{ regex: RegExp; designation: string; category?: string }> = [];

  constructor(gazetteerPath: string) {
    const content = readFileSync(gazetteerPath, 'utf-8');
    const data = parseYaml(content) as GazetteerFile;

    for (const entry of data.equipment) {
      const names = [entry.designation, ...(entry.aliases ?? [])];
      for (const name of names) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        this.patterns.push({
          regex: new RegExp(`\\b${escaped}\\b`, 'gi'),
          designation: entry.designation,
          category: entry.category,
        });
      }
    }
  }

  async extract(text: string): Promise<ExtractedEntity[]> {
    const matched = new Map<string, ExtractedEntity>();

    for (const pattern of this.patterns) {
      const regex = new RegExp(pattern.regex);
      const match = regex.exec(text);
      if (match) {
        if (!matched.has(pattern.designation)) {
          matched.set(pattern.designation, {
            type: 'Equipment',
            name: pattern.designation,
            context: this.extractContext(text, match[0]),
            confidence: 1.0,
          });
        }
      }
    }

    return [...matched.values()];
  }

  private extractContext(text: string, name: string): string {
    const idx = text.indexOf(name);
    if (idx === -1) return '';
    const start = Math.max(0, idx - 25);
    const end = Math.min(text.length, idx + name.length + 25);
    return text.slice(start, end).trim();
  }
}
