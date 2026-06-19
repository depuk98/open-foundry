/**
 * Tests for entity-validation.ts — cleaning and validation rules.
 */

import { describe, it, expect } from 'vitest';
import { cleanEntityName, validateEntity } from '../entity-validation.js';
import type { ExtractedEntity } from '../types.js';

function makeEntity(name: string, type: string, confidence = 0.8): ExtractedEntity {
  return { name, type, confidence };
}

// ===========================================================================
// CLEANING
// ===========================================================================

describe('cleanEntityName', () => {
  it('strips possessive', () => expect(cleanEntityName("Beirut's")).toBe('Beirut'));
  it('strips trailing punctuation', () => expect(cleanEntityName('Washington.')).toBe('Washington'));
  it('strips multiple trailing punctuation', () => expect(cleanEntityName('NATO?!')).toBe('NATO'));
  it('strips emoji', () => expect(cleanEntityName('🔥Ukraine🔥')).toBe('Ukraine'));
  it('strips leading/trailing quotes', () => expect(cleanEntityName('"NATO"')).toBe('NATO'));
  it('strips hashtag', () => expect(cleanEntityName('#Ukraine')).toBe('Ukraine'));
  it('normalizes whitespace', () => expect(cleanEntityName('New  York')).toBe('New York'));
  it('returns null for emoji-only', () => expect(cleanEntityName('🔥')).toBeNull());
  it('applies all cleaners in order', () => {
    const result = cleanEntityName("#Beirut's.");
    expect(result).toBe('Beirut');
  });
  it('respects disabled cleaner via config', () => {
    const result = cleanEntityName("Beirut's", { enabled: true, clean: { stripPossessive: false } });
    expect(result).toBe("Beirut's"); // possessive preserved
  });
});

// ===========================================================================
// PERSON RULES
// ===========================================================================

describe('Person rules', () => {
  describe('no-handles', () => {
    it('rejects CamelCase handle (ChristopherJM)', () => {
      const r = validateEntity(makeEntity('ChristopherJM', 'Person'), '');
      expect(r.valid).toBe(false);
      expect('reason' in r && r.reason).toContain('handle');
    });
    it('rejects lowercase_alphanumeric handle (deaidua)', () => {
      const r = validateEntity(makeEntity('deaidua', 'Person'), '');
      expect(r.valid).toBe(false);
    });
    it('rejects underscore handle (gen_jackkeane)', () => {
      const r = validateEntity(makeEntity('gen_jackkeane', 'Person'), '');
      expect(r.valid).toBe(false);
    });
    it('accepts simple lowercase name (john)', () => {
      expect(validateEntity(makeEntity('john', 'Person'), '').valid).toBe(true);
    });
    it('accepts Capitalized name (Zelensky)', () => {
      expect(validateEntity(makeEntity('Zelensky', 'Person'), '').valid).toBe(true);
    });
    it('accepts multi-word name (President Zelensky)', () => {
      expect(validateEntity(makeEntity('President Zelensky', 'Person'), '').valid).toBe(true);
    });
  });

  describe('no-numbers', () => {
    it('rejects Jeff21461', () => {
      expect(validateEntity(makeEntity('Jeff21461', 'Person'), '').valid).toBe(false);
    });
    it('rejects Chris007', () => {
      expect(validateEntity(makeEntity('Chris007', 'Person'), '').valid).toBe(false);
    });
    it('rejects J20 (letter+number pattern)', () => {
      expect(validateEntity(makeEntity('J20', 'Person'), '').valid).toBe(false);
    });
  });

  describe('no-titles-only', () => {
    it('rejects standalone President', () => {
      expect(validateEntity(makeEntity('President', 'Person'), '').valid).toBe(false);
    });
    it('rejects standalone Minister', () => {
      expect(validateEntity(makeEntity('Minister', 'Person'), '').valid).toBe(false);
    });
    it('accepts President Zelensky (multi-word)', () => {
      expect(validateEntity(makeEntity('President Zelensky', 'Person'), '').valid).toBe(true);
    });
  });

  describe('min-length', () => {
    it('rejects single char', () => {
      expect(validateEntity(makeEntity('X', 'Person'), '').valid).toBe(false);
    });
    it('accepts 2-char name', () => {
      expect(validateEntity(makeEntity('Xi', 'Person'), '').valid).toBe(true);
    });
  });

  describe('no-descriptions', () => {
    it('rejects Development Associate', () => {
      expect(validateEntity(makeEntity('Development Associate', 'Person'), '').valid).toBe(false);
    });
    it('rejects Program Manager', () => {
      expect(validateEntity(makeEntity('Program Manager', 'Person'), '').valid).toBe(false);
    });
  });
});

// ===========================================================================
// ORGANIZATION RULES
// ===========================================================================

describe('Organization rules', () => {
  describe('no-handles', () => {
    it('rejects CamelCase handle (CalibreObscura)', () => {
      expect(validateEntity(makeEntity('CalibreObscura', 'Organization'), '').valid).toBe(false);
    });
    it('rejects lowercase handle (bayraktar)', () => {
      expect(validateEntity(makeEntity('bayraktar', 'Organization'), '').valid).toBe(false);
    });
    it('accepts real organization (NATO)', () => {
      expect(validateEntity(makeEntity('NATO', 'Organization'), '').valid).toBe(true);
    });
    it('accepts multi-word org (Wagner Group)', () => {
      expect(validateEntity(makeEntity('Wagner Group', 'Organization'), '').valid).toBe(true);
    });
  });

  describe('no-roles', () => {
    it('rejects Tanzanian foreign minister', () => {
      expect(validateEntity(makeEntity('Tanzanian foreign minister', 'Organization'), '').valid).toBe(false);
    });
    it('rejects Israeli ambassador', () => {
      expect(validateEntity(makeEntity('Israeli ambassador', 'Organization'), '').valid).toBe(false);
    });
    it('accepts single-word title (Minister)', () => {
      expect(validateEntity(makeEntity('Minister', 'Organization'), '').valid).toBe(true);
    });
  });

  describe('no-generic-nouns', () => {
    it('rejects troops', () => {
      expect(validateEntity(makeEntity('troops', 'Organization'), '').valid).toBe(false);
    });
    it('rejects regime', () => {
      expect(validateEntity(makeEntity('regime', 'Organization'), '').valid).toBe(false);
    });
    it('accepts multi-word generic (state universities)', () => {
      expect(validateEntity(makeEntity('state universities', 'Organization'), '').valid).toBe(true);
    });
  });

  describe('min-length', () => {
    it('rejects B', () => {
      expect(validateEntity(makeEntity('B', 'Organization'), '').valid).toBe(false);
    });
    it('accepts UN', () => {
      expect(validateEntity(makeEntity('UN', 'Organization'), '').valid).toBe(true);
    });
  });
});

// ===========================================================================
// EQUIPMENT RULES
// ===========================================================================

describe('Equipment rules', () => {
  describe('no-commercial', () => {
    it('rejects UK-registered yacht', () => {
      expect(validateEntity(makeEntity('UK-registered yacht', 'Equipment'), '').valid).toBe(false);
    });
    it('rejects commercial shipping', () => {
      expect(validateEntity(makeEntity('commercial shipping', 'Equipment'), '').valid).toBe(false);
    });
    it('accepts Anti-shipping missile (word-boundary)', () => {
      expect(validateEntity(makeEntity('Anti-shipping missile', 'Equipment'), '').valid).toBe(true);
    });
    it('rejects Cargo aircraft (commercial term)', () => {
      expect(validateEntity(makeEntity('Cargo aircraft', 'Equipment'), '').valid).toBe(false);
    });
  });

  describe('no-alert-systems', () => {
    it('rejects Sirens', () => {
      expect(validateEntity(makeEntity('Sirens', 'Equipment'), '').valid).toBe(false);
    });
    it('rejects siren (singular)', () => {
      expect(validateEntity(makeEntity('siren', 'Equipment'), '').valid).toBe(false);
    });
    it('rejects alarms', () => {
      expect(validateEntity(makeEntity('alarms', 'Equipment'), '').valid).toBe(false);
    });
  });

  describe('no-generic-only', () => {
    it('rejects drones (single lowercase)', () => {
      expect(validateEntity(makeEntity('drones', 'Equipment'), '').valid).toBe(false);
    });
    it('rejects missiles', () => {
      expect(validateEntity(makeEntity('missiles', 'Equipment'), '').valid).toBe(false);
    });
    it('accepts Patriot (capitalized proper name)', () => {
      expect(validateEntity(makeEntity('Patriot', 'Equipment'), '').valid).toBe(true);
    });
    it('accepts HIMARS (capitalized)', () => {
      expect(validateEntity(makeEntity('HIMARS', 'Equipment'), '').valid).toBe(true);
    });
    it('accepts AN-196 Lyutyiy (multi-word)', () => {
      expect(validateEntity(makeEntity('AN-196 Lyutyiy', 'Equipment'), '').valid).toBe(true);
    });
  });

  describe('no-truncated', () => {
    it('rejects FP-1 stri (truncated suffix)', () => {
      expect(validateEntity(makeEntity('FP-1 stri', 'Equipment'), '').valid).toBe(false);
    });
    it('rejects Loaf destr', () => {
      expect(validateEntity(makeEntity('Loaf destr', 'Equipment'), '').valid).toBe(false);
    });
    it('accepts destroyer (whole word, not truncated)', () => {
      expect(validateEntity(makeEntity('destroyer', 'Equipment'), '').valid).toBe(true);
    });
  });

  describe('min-designation', () => {
    it('rejects single lowercase short word (Radar)', () => {
      expect(validateEntity(makeEntity('radar', 'Equipment'), '').valid).toBe(false);
    });
    it('accepts capitalized short word (NASAMS)', () => {
      expect(validateEntity(makeEntity('NASAMS', 'Equipment'), '').valid).toBe(true);
    });
    it('accepts multi-word (air defense system)', () => {
      expect(validateEntity(makeEntity('air defense system', 'Equipment'), '').valid).toBe(true);
    });
  });
});

// ===========================================================================
// LOCATION RULES
// ===========================================================================

describe('Location rules', () => {
  describe('no-descriptions', () => {
    it('rejects Sverdlovsk region (suffix)', () => {
      expect(validateEntity(makeEntity('Sverdlovsk region', 'Location'), '').valid).toBe(false);
    });
    it('rejects coastal areas (prefix)', () => {
      expect(validateEntity(makeEntity('coastal areas', 'Location'), '').valid).toBe(false);
    });
    it('rejects northern border (prefix)', () => {
      expect(validateEntity(makeEntity('northern border', 'Location'), '').valid).toBe(false);
    });
    it('accepts Kyiv (real location)', () => {
      expect(validateEntity(makeEntity('Kyiv', 'Location'), '').valid).toBe(true);
    });
    it('accepts Washington DC', () => {
      expect(validateEntity(makeEntity('Washington DC', 'Location'), '').valid).toBe(true);
    });
  });

  describe('min-length', () => {
    it('rejects B', () => {
      expect(validateEntity(makeEntity('B', 'Location'), '').valid).toBe(false);
    });
    it('accepts US', () => {
      expect(validateEntity(makeEntity('US', 'Location'), '').valid).toBe(true);
    });
  });
});

// ===========================================================================
// INTEGRATION TESTS
// ===========================================================================

describe('validateEntity integration', () => {
  it('cleans before validating', () => {
    // Beirut's -> Beirut (cleaned) -> passes Location rules
    const r = validateEntity(makeEntity("Beirut's", 'Location'), '');
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.entity.name).toBe('Beirut');
  });

  it('returns cleaned entity name on valid', () => {
    const r = validateEntity(makeEntity('#Ukraine', 'Location'), '');
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.entity.name).toBe('Ukraine');
  });

  it('rejects when cleaning produces empty', () => {
    const r = validateEntity(makeEntity('🔥', 'Location'), '');
    expect(r.valid).toBe(false);
  });

  it('passes through unknown types', () => {
    const r = validateEntity(makeEntity('Something', 'UnknownType'), '');
    expect(r.valid).toBe(true);
  });

  it('respects disabled rules via config', () => {
    const cfg = { enabled: true, rules: { person: ['min-length'] } }; // only min-length enabled
    const r = validateEntity(makeEntity('ChristopherJM', 'Person'), '', cfg);
    expect(r.valid).toBe(true); // handle passes because no-handles not in the enabled list
  });

  it('respects validation.enabled=false', () => {
    const r = validateEntity(makeEntity('ChristopherJM', 'Person'), '', { enabled: false });
    expect(r.valid).toBe(true);
  });

  it('first failure short-circuits (AND logic)', () => {
    // 'B' fails both no-handles AND min-length — should return first failure reason
    const r = validateEntity(makeEntity('b', 'Location'), '');
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBeDefined();
  });
});

// ===========================================================================
// MAPPED TYPES
// ===========================================================================

describe('Mapped types use parent rules', () => {
  it('WeaponSystem rejects commercial keyword', () => {
    expect(validateEntity(makeEntity('commercial shipping', 'WeaponSystem'), '').valid).toBe(false);
  });
  it('WeaponSystem accepts HIMARS', () => {
    expect(validateEntity(makeEntity('HIMARS', 'WeaponSystem'), '').valid).toBe(true);
  });
  it('MilitaryUnit rejects handle', () => {
    expect(validateEntity(makeEntity('ukr_army', 'MilitaryUnit'), '').valid).toBe(false);
  });
  it('MilitaryUnit accepts 4th Guards Tank Division', () => {
    expect(validateEntity(makeEntity('4th Guards Tank Division', 'MilitaryUnit'), '').valid).toBe(true);
  });
  it('ArmedGroup rejects generic noun', () => {
    expect(validateEntity(makeEntity('troops', 'ArmedGroup'), '').valid).toBe(false);
  });
  it('ArmedGroup accepts Wagner Group', () => {
    expect(validateEntity(makeEntity('Wagner Group', 'ArmedGroup'), '').valid).toBe(true);
  });
  it('ConflictZone rejects descriptive phrase', () => {
    expect(validateEntity(makeEntity('border region', 'ConflictZone'), '').valid).toBe(false);
  });
  it('ConflictZone accepts Donbas', () => {
    expect(validateEntity(makeEntity('Donbas', 'ConflictZone'), '').valid).toBe(true);
  });
});
