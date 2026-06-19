/**
 * Browser cookie extraction for Twitter/X authentication.
 *
 * Auto-extracts auth_token and ct0 from the local browser cookie
 * store — no API keys, env vars, or user input required.
 *
 * Approach mirrors twitter-cli's behavior:
 *   1. Locate the Chrome/Edge/Firefox cookie database
 *   2. Read x.com / twitter.com auth cookies
 *   3. Decrypt encrypted values using OS-native keychain
 *   4. Return { authToken, ct0 } or null if not logged in
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

// ── Types ──────────────────────────────────────────────────────────────

export interface TwitterAuth {
  authToken: string;
  ct0: string;
}

export interface AuthSource {
  browser: string;
  profile: string;
  extractedAt: string;
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Extract Twitter/X auth cookies from the user's browser cookie store.
 *
 * Tries browsers in order: Chrome → Edge → Firefox → Brave → Chromium.
 * Returns null if no logged-in x.com session is found.
 */
export async function extractTwitterAuth(): Promise<{ auth: TwitterAuth; source: AuthSource } | null> {
  if (platform() === 'darwin') return extractFromMacOS();
  if (platform() === 'linux') return extractFromLinux();
  if (platform() === 'win32') return extractFromWindows();
  return null;
}

/**
 * Extract from environment variables (fallback for server/headless).
 */
export function extractFromEnv(): TwitterAuth | null {
  const authToken = process.env['TWITTER_AUTH_TOKEN'];
  const ct0 = process.env['TWITTER_CT0'];
  if (authToken && ct0) return { authToken, ct0 };
  return null;
}

// ── macOS Extraction ───────────────────────────────────────────────────

async function extractFromMacOS(): Promise<{ auth: TwitterAuth; source: AuthSource } | null> {
  const browsers = macBrowserPaths();
  for (const { name, cookiePath } of browsers) {
    if (!existsSync(cookiePath)) continue;
    const auth = tryDecryptMacOS(name, cookiePath);
    if (auth) return { auth, source: { browser: name, profile: 'Default', extractedAt: new Date().toISOString() } };
  }
  return null;
}

function macBrowserPaths(): Array<{ name: string; cookiePath: string }> {
  const lib = join(homedir(), 'Library', 'Application Support');
  return [
    { name: 'Chrome',     cookiePath: join(lib, 'Google/Chrome/Default/Cookies') },
    { name: 'Edge',       cookiePath: join(lib, 'Microsoft Edge/Default/Cookies') },
    { name: 'Brave',      cookiePath: join(lib, 'BraveSoftware/Brave-Browser/Default/Cookies') },
    { name: 'Chromium',   cookiePath: join(lib, 'Chromium/Default/Cookies') },
    { name: 'Firefox',    cookiePath: firefoxCookiePath() },
  ];
}

// ── macOS: Decrypt Chrome cookies via Keychain ─────────────────────────

function tryDecryptMacOS(browser: string, cookiePath: string): TwitterAuth | null {
  try {
    const chromeSafeStorage = getChromeSafeStoragePassword(browser);

    // Use Python with the same libraries twitter-cli uses internally.
    // browser_cookie3 handles decryption transparently across OSes.
    const script = `
import browser_cookie3, json, sys
try:
    cj = browser_cookie3.${pythonLoaderFor(browser)}(cookie_file='${cookiePath.replace(/'/g, "\\'")}')
    auth_token = None
    ct0 = None
    for cookie in cj:
        if '.x.com' in cookie.domain or cookie.domain == 'x.com':
            if cookie.name == 'auth_token':
                auth_token = cookie.value
            elif cookie.name == 'ct0':
                ct0 = cookie.value
    if auth_token and ct0:
        print(json.dumps({'authToken': auth_token, 'ct0': ct0}))
    else:
        print('')
except Exception as e:
    print(json.dumps({'error': str(e)}), file=sys.stderr)
`;
    const result = execSync('python3 -c ' + JSON.stringify(script), {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (!result) return null;
    const parsed = JSON.parse(result) as { authToken?: string; ct0?: string; error?: string };
    if (parsed.error || !parsed.authToken || !parsed.ct0) return null;
    return { authToken: parsed.authToken, ct0: parsed.ct0 };
  } catch {
    return null;
  }
}

/**
 * Get the Chrome Safe Storage password from macOS Keychain.
 * Chrome encrypts cookies with a key stored in the Keychain under
 * the service name "Chrome Safe Storage" (or "Chromium Safe Storage").
 */
function getChromeSafeStoragePassword(browser: string): string {
  const serviceName = browser === 'Chrome' ? 'Chrome Safe Storage'
    : browser === 'Brave' ? 'Brave Safe Storage'
    : browser === 'Edge' ? 'Microsoft Edge Safe Storage'
    : 'Chromium Safe Storage';

  try {
    return execSync(
      `security find-generic-password -wa '${serviceName}'`,
      { encoding: 'utf-8', timeout: 5_000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
  } catch {
    return '';
  }
}

function pythonLoaderFor(browser: string): string {
  switch (browser) {
    case 'Chrome':   return 'chrome';
    case 'Edge':     return 'chromium';  // Edge uses Chromium backend
    case 'Brave':    return 'chrome';    // Brave uses Chrome backend
    case 'Chromium': return 'chromium';
    case 'Firefox':  return 'firefox';
    default:         return 'chrome';
  }
}

// ── Firefox cookie path ────────────────────────────────────────────────

function firefoxCookiePath(): string {
  const ffDir = join(homedir(), 'Library', 'Application Support', 'Firefox', 'Profiles');
  if (!existsSync(ffDir)) return '';

  // Find the default-release profile
  try {
    const entries = readFileSync(join(ffDir, 'profiles.ini'), 'utf-8');
    const match = entries.match(/Path=([^\r\n]+)/);
    if (match) return join(ffDir, match[1]!, 'cookies.sqlite');
  } catch {
    // Fall back to first profile directory
  }

  // Find any profile directory with cookies.sqlite
  try {
    const { readdirSync } = require('node:fs');
    const dirs = readdirSync(ffDir).filter((d: string) => d.endsWith('.default-release') || d.endsWith('.default'));
    for (const dir of dirs) {
      const p = join(ffDir, dir, 'cookies.sqlite');
      if (existsSync(p)) return p;
    }
  } catch { /* ignore */ }

  return '';
}

// ─── Linux Extraction ──────────────────────────────────────────────────

async function extractFromLinux(): Promise<{ auth: TwitterAuth; source: AuthSource } | null> {
  const browsers = [
    { name: 'Chrome',  path: join(homedir(), '.config/google-chrome/Default/Cookies') },
    { name: 'Edge',    path: join(homedir(), '.config/microsoft-edge/Default/Cookies') },
    { name: 'Firefox', path: linuxFirefoxCookiePath() },
  ];
  for (const { name, path: cookiePath } of browsers) {
    if (!existsSync(cookiePath)) continue;

    // On Linux, Chrome uses GNOME Keyring or libsecret. Try Python browser_cookie3.
    try {
      const script = `
import browser_cookie3, json
cj = browser_cookie3.${name === 'Firefox' ? 'firefox' : 'chrome'}(cookie_file='${cookiePath.replace(/'/g, "\\'")}')
auth_token = ct0 = None
for c in cj:
    if ('x.com' in (c.domain or '')) and c.name == 'auth_token': auth_token = c.value
    if ('x.com' in (c.domain or '')) and c.name == 'ct0': ct0 = c.value
print(json.dumps({'authToken': auth_token, 'ct0': ct0}) if auth_token and ct0 else '')
`;
      const result = execSync('python3 -c ' + JSON.stringify(script), { encoding: 'utf-8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (result) {
        const p = JSON.parse(result);
        if (p.authToken) return { auth: p, source: { browser: name, profile: 'Default', extractedAt: new Date().toISOString() } };
      }
    } catch { /* try next browser */ }
  }
  return null;
}

function linuxFirefoxCookiePath(): string {
  const base = join(homedir(), '.mozilla', 'firefox');
  if (!existsSync(base)) return '';
  try {
    const { readdirSync } = require('node:fs');
    const dirs = readdirSync(base).filter((d: string) => d.endsWith('.default-release') || d.endsWith('.default'));
    for (const d of dirs) {
      const p = join(base, d, 'cookies.sqlite');
      if (existsSync(p)) return p;
    }
  } catch { /* ignore */ }
  return '';
}

// ─── Windows Extraction ────────────────────────────────────────────────

async function extractFromWindows(): Promise<{ auth: TwitterAuth; source: AuthSource } | null> {
  const localAppData = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
  const browsers = [
    { name: 'Chrome',  path: join(localAppData, 'Google/Chrome/User Data/Default/Network/Cookies') },
    { name: 'Edge',    path: join(localAppData, 'Microsoft/Edge/User Data/Default/Network/Cookies') },
  ];
  for (const { name, path: cookiePath } of browsers) {
    if (!existsSync(cookiePath)) continue;
    try {
      const script = `
import browser_cookie3, json
cj = browser_cookie3.${name === 'Edge' ? 'chromium' : 'chrome'}(cookie_file=r'${cookiePath.replace(/'/g, "\\'")}')
auth_token = ct0 = None
for c in cj:
    if 'x.com' in (c.domain or '') and c.name == 'auth_token': auth_token = c.value
    if 'x.com' in (c.domain or '') and c.name == 'ct0': ct0 = c.value
print(json.dumps({'authToken': auth_token, 'ct0': ct0}) if auth_token and ct0 else '')
`;
      const result = execSync('python -c ' + JSON.stringify(script), { encoding: 'utf-8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (result) {
        const p = JSON.parse(result);
        if (p.authToken) return { auth: p, source: { browser: name, profile: 'Default', extractedAt: new Date().toISOString() } };
      }
    } catch { /* try next */ }
  }
  return null;
}
