/**
 * Shared deduplication utilities for the entity extraction pipeline.
 *
 * Exported so both EntityDedupCache (cache key + DB query) and
 * EntityExtractionService (populate _normalizedName on entity creation)
 * use identical normalization logic.
 */

const TITLE_PATTERN = /^(President|General|Gen|Admiral|Colonel|Col\.?|Captain|Capt\.?|Major|Maj\.?|Lieutenant|Lt\.?|Sergeant|Sgt\.?|Secretary|Minister|Dr\.?|Mr\.?|Ms\.?|Mrs\.?|King|Queen|Prince|Princess|Sheikh|Ayatollah|Crown Prince|Sir|Lord|Lady|Dame|Bishop|Archbishop|Cardinal|Rabbi|Imam|Chancellor|Governor|Senator|Congressman|Congresswoman|Ambassador|Marshal|Commander|Chief)\s+/i;

const TITLE_STRIP_TYPES = new Set(['Person']);

/**
 * Normalize an entity name for deduplication.
 *
 * Person names: title prefixes are stripped iteratively (handles multi-title
 * like "Mr President Trump"), then lowercased with NFC normalization.
 * Fallback to raw+lowercase if all text was titles.
 *
 * Organization, Location, Equipment, Event names: lowercased + NFC only
 * (titles are semantically meaningful for those types).
 */
export function normalizeForDedup(type: string, name: string): string {
  const trimmed = name.trim().normalize('NFC');
  if (!TITLE_STRIP_TYPES.has(type)) return trimmed.toLowerCase();
  let result = trimmed;
  for (;;) {
    const stripped = result.replace(TITLE_PATTERN, '').trim();
    if (stripped === result) break;
    result = stripped;
  }
  if (result.length === 0) return trimmed.toLowerCase();
  return result.toLowerCase();
}
