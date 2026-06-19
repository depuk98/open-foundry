/**
 * Tests for browser cookie extraction module.
 */

import { describe, it, expect } from 'vitest';
import { extractFromEnv } from '../browser-cookies.js';

describe('OSINT Domain Pack — Browser Cookie Auth', () => {
  describe('extractFromEnv (fallback)', () => {
    it('returns null when env vars are not set', () => {
      const prevAuth = process.env['TWITTER_AUTH_TOKEN'];
      const prevCt0 = process.env['TWITTER_CT0'];
      delete process.env['TWITTER_AUTH_TOKEN'];
      delete process.env['TWITTER_CT0'];

      const result = extractFromEnv();
      expect(result).toBeNull();

      if (prevAuth) process.env['TWITTER_AUTH_TOKEN'] = prevAuth;
      if (prevCt0) process.env['TWITTER_CT0'] = prevCt0;
    });

    it('returns auth when env vars are set', () => {
      process.env['TWITTER_AUTH_TOKEN'] = 'test-token-123';
      process.env['TWITTER_CT0'] = 'test-ct0-456';

      const result = extractFromEnv();
      expect(result).toEqual({ authToken: 'test-token-123', ct0: 'test-ct0-456' });

      delete process.env['TWITTER_AUTH_TOKEN'];
      delete process.env['TWITTER_CT0'];
    });

    it('returns null when only authToken is set', () => {
      process.env['TWITTER_AUTH_TOKEN'] = 'test-token-123';
      delete process.env['TWITTER_CT0'];

      const result = extractFromEnv();
      expect(result).toBeNull();

      delete process.env['TWITTER_AUTH_TOKEN'];
    });
  });
});
