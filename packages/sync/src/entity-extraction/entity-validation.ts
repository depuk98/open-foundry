/**
 * Pre-storage entity validation and cleaning.
 *
 * Cleaning functions transform entity names before validation.
 * Validation rules reject entities that don't belong in the knowledge graph.
 * Rules are AND-composition — ALL enabled rules must pass. First failure short-circuits.
 */

import type { ExtractedEntity, ValidationConfig } from './types.js';

export type ValidationResult = { valid: true; entity: ExtractedEntity } | { valid: false; reason: string };

export interface ValidationRule {
  name: string;
  check: (entity: ExtractedEntity, sourceText: string) => ValidationResult;
}

// ---------------------------------------------------------------------------
// Cleaning functions
// ---------------------------------------------------------------------------

function stripHashtag(name: string): string { return name.replace(/^#+/, '').trim(); }
function stripPossessive(name: string): string { return name.replace(/'s?$/g, '').trim(); }
function stripTrailingPunct(name: string): string { return name.replace(/[.,;:!?]+$/g, '').trim(); }
function stripEmoji(name: string): string {
  return name.replace(/[\u{1F600}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{FE0F}]/gu, '').trim();
}
function stripQuotes(name: string): string { return name.replace(/^["'`]+|["'`]+$/g, '').trim(); }
function normalizeWhitespace(name: string): string { return name.replace(/\s+/g, ' ').trim(); }

type Cleaner = (name: string) => string;

const ALL_CLEANERS: Array<{ name: string; fn: Cleaner; configKey: string }> = [
  { name: 'stripHashtag', fn: stripHashtag, configKey: 'stripHashtag' },
  { name: 'stripEmoji', fn: stripEmoji, configKey: 'stripEmoji' },
  { name: 'stripQuotes', fn: stripQuotes, configKey: 'stripQuotes' },
  { name: 'stripTrailingPunct', fn: stripTrailingPunct, configKey: 'stripTrailingPunct' },
  { name: 'stripPossessive', fn: stripPossessive, configKey: 'stripPossessive' },
  { name: 'normalizeWhitespace', fn: normalizeWhitespace, configKey: 'normalizeWhitespace' },
];

export function cleanEntityName(name: string, config?: ValidationConfig): string | null {
  let cleaned = name;
  for (const { fn, configKey } of ALL_CLEANERS) {
    const cfg = config?.clean as Record<string, boolean | undefined> | undefined;
    if (cfg && cfg[configKey] === false) continue;
    cleaned = fn(cleaned);
  }
  if (cleaned.length === 0) return null;
  return cleaned;
}

// ---------------------------------------------------------------------------
// Validation Rules
// ---------------------------------------------------------------------------

const PERSON_RULES: ValidationRule[] = [
  {
    name: 'no-handles',
    check: (e) => {
      const name = e.name;
      if (name.includes(' ')) return { valid: true, entity: e };
      if (/^[A-Z][a-z]+[A-Z]/.test(name)) {
        return { valid: false, reason: `looks like a CamelCase handle: ${name}` };
      }
      if (/^[a-z][a-z0-9_]{2,}$/.test(name) && /[_0-9]/.test(name)) {
        return { valid: false, reason: `looks like a lowercase handle with numbers/underscores: ${name}` };
      }
      // Lowercase-only names > 5 chars with no common name pattern are likely handles
      if (/^[a-z]{6,}$/.test(name) && !/^(john|mark|omar|ivan|peter|adam|anna|lisa|sara|paul|mike|dave|alex|eric|nick|ryan|kyle)$/i.test(name)) {
        return { valid: false, reason: `looks like a generated handle (>5 lowercase chars): ${name}` };
      }
      return { valid: true, entity: e };
    },
  },
  {
    name: 'no-numbers',
    check: (e) => {
      if (/^[A-Za-z]+\d+$/.test(e.name)) {
        return { valid: false, reason: `name with trailing numbers: ${e.name}` };
      }
      return { valid: true, entity: e };
    },
  },
  {
    name: 'no-titles-only',
    check: (e) => {
      if (/^(President|Minister|Secretary|General|Admiral|Colonel|Captain|Major|Lieutenant|Sergeant|Sgt|Dr|Mr|Ms|Mrs)$/i.test(e.name)) {
        return { valid: false, reason: `standalone title: ${e.name}` };
      }
      return { valid: true, entity: e };
    },
  },
  {
    name: 'min-length',
    check: (e) => {
      if (e.name.length < 2) return { valid: false, reason: `name too short (<2): ${e.name}` };
      return { valid: true, entity: e };
    },
  },
  {
    name: 'no-descriptions',
    check: (e) => {
      if (e.name.includes(' ') && /\b(associate|assistant|director|manager|officer|analyst|coordinator|specialist|representative)\b/i.test(e.name)) {
        return { valid: false, reason: `job description: ${e.name}` };
      }
      return { valid: true, entity: e };
    },
  },
];

const ORG_RULES: ValidationRule[] = [
  {
    name: 'no-handles',
    check: PERSON_RULES[0]!.check,
  },
  {
    name: 'no-roles',
    check: (e) => {
      if (e.name.includes(' ') && /\b(minister|secretary|spokesman|spokesperson|ambassador|envoy|official|senator|congressman|congresswoman|representative)\b/i.test(e.name)) {
        return { valid: false, reason: `role/title: ${e.name}` };
      }
      return { valid: true, entity: e };
    },
  },
  {
    name: 'no-generic-nouns',
    check: (e) => {
      if (e.name.includes(' ')) return { valid: true, entity: e };
      if (/^[A-Z]/.test(e.name)) return { valid: true, entity: e };
      if (/^(troop|troops|regime|regimes|army|armies|navy|navies|force|forces|government|governments|republic|university|universities|company|companies|corporation)$/i.test(e.name.toLowerCase())) {
        return { valid: false, reason: `generic noun: ${e.name}` };
      }
      return { valid: true, entity: e };
    },
  },
  {
    name: 'min-length',
    check: (e) => {
      if (e.name.length < 2) return { valid: false, reason: `too short (<2): ${e.name}` };
      return { valid: true, entity: e };
    },
  },
];

const EQUIPMENT_RULES: ValidationRule[] = [
  {
    name: 'no-commercial',
    check: (e) => {
      if (/(?:^|\s)(shipping|traffic|cargo|trade|yacht|civilian|commercial|passenger|tourist)(?:\s|$)/i.test(e.name)) {
        return { valid: false, reason: `commercial term: ${e.name}` };
      }
      return { valid: true, entity: e };
    },
  },
  {
    name: 'no-alert-systems',
    check: (e) => {
      if (/\b(siren|alarm|alert|warning|announcement)s?\b/i.test(e.name)) {
        return { valid: false, reason: `alert system: ${e.name}` };
      }
      return { valid: true, entity: e };
    },
  },
  {
    name: 'no-generic-only',
    check: (e) => {
      if (e.name.includes(' ')) return { valid: true, entity: e };
      if (/^[A-Z0-9]/.test(e.name)) return { valid: true, entity: e };
      if (/^(drone|drones|missile|missiles|tank|tanks|jet|jets|ship|ships|submarine|radar|system|vehicle|helicopter|aircraft|artillery|gun|rocket|bomb|shell)$/i.test(e.name.toLowerCase())) {
        return { valid: false, reason: `generic term: ${e.name}` };
      }
      return { valid: true, entity: e };
    },
  },
  {
    name: 'no-truncated',
    check: (e) => {
      if (/\s\w*(stri|destr|oper|atta)$/i.test(e.name)) {
        return { valid: false, reason: `truncated: ${e.name}` };
      }
      return { valid: true, entity: e };
    },
  },
  {
    name: 'min-designation',
    check: (e) => {
      if (e.name.includes(' ')) return { valid: true, entity: e };
      if (/^[A-Z0-9]/.test(e.name)) return { valid: true, entity: e };
      if (e.name.length < 4) return { valid: false, reason: `generic short: ${e.name}` };
      return { valid: true, entity: e };
    },
  },
];

const LOCATION_RULES: ValidationRule[] = [
  {
    name: 'no-descriptions',
    check: (e) => {
      if (/^(region|area|zone|coastal|northern|southern|eastern|western|border)\s/i.test(e.name) || /\s(region|area|zone|border)$/i.test(e.name)) {
        return { valid: false, reason: `descriptive: ${e.name}` };
      }
      return { valid: true, entity: e };
    },
  },
  {
    name: 'min-length',
    check: (e) => {
      if (e.name.length < 2) return { valid: false, reason: `too short (<2): ${e.name}` };
      return { valid: true, entity: e };
    },
  },
];

const RULES_BY_TYPE: Record<string, ValidationRule[]> = {
  Person: PERSON_RULES,
  Organization: ORG_RULES,
  Equipment: EQUIPMENT_RULES,
  Location: LOCATION_RULES,
  WeaponSystem: EQUIPMENT_RULES,
  MilitaryUnit: ORG_RULES,
  ArmedGroup: ORG_RULES,
  ConflictZone: LOCATION_RULES,
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function validateEntity(
  entity: ExtractedEntity,
  _sourceText: string,
  config?: ValidationConfig,
): ValidationResult {
  if (config?.enabled === false) {
    return { valid: true, entity };
  }

  const cleanedName = cleanEntityName(entity.name, config);
  if (cleanedName === null) {
    return { valid: false, reason: 'cleaning produced empty name' };
  }

  const rules = RULES_BY_TYPE[entity.type];
  if (!rules) {
    return { valid: true, entity: { ...entity, name: cleanedName } };
  }

  const enabledRules = rules.filter((rule) => {
    const ruleConfig = config?.rules as Record<string, string[] | undefined> | undefined;
    const typeRules = ruleConfig?.[entity.type.toLowerCase()];
    if (!typeRules) return true;
    if (typeRules.length === 0) return false;
    return typeRules.includes(rule.name);
  });

  const cleanedEntity: ExtractedEntity = { ...entity, name: cleanedName };
  for (const rule of enabledRules) {
    const result = rule.check(cleanedEntity, _sourceText);
    if (!result.valid) return result;
  }

  return { valid: true, entity: cleanedEntity };
}
