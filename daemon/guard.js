/**
 * Request guard: decides which requests may reach the daemon, on each of its listeners
 * (CLAUDE.md, Invariants).
 *
 * - Host must be one of the names the listener answers to (`host:port`), so a DNS-rebinding
 *   page cannot pose as it: on loopback, `LOOPBACK_HOSTS`; on the remote listener Phone access
 *   opens, the Mac's tailnet address and names (remote.js).
 * - API requests must carry the token cookie. It is SameSite=Strict, so the browser never
 *   attaches it to a request started by another site.
 * - A request with a foreign Origin (or a cross-site Sec-Fetch-Site) is refused even with
 *   the cookie, and state-changing requests must state their Origin.
 */
import { timingSafeEqual } from 'node:crypto';

export const TOKEN_COOKIE = 'ac_token';

/** @typedef {{ ok: true } | { ok: false, status: number, error: string }} Verdict */

/**
 * Names the daemon answers to on loopback. Each is loopback whatever DNS says: browsers
 * hard-code `*.localhost` to loopback (RFC 6761). Kept explicit rather than every `*.localhost`.
 */
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', 'cockpit.localhost']);

/** @param {string | null} host @param {readonly string[]} names the listener's `host:port` names */
export const isAllowedHost = (host, names) => host !== null && names.includes(host);

/** @param {string | null} header @returns {Map<string, string>} */
function parseCookies(header) {
  const cookies = new Map();
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return cookies;
}

/** Constant-time comparison. @param {string | undefined} given @param {string} token */
export function tokensMatch(given, token) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** @param {number} status @param {string} error @returns {Verdict} */
const deny = (status, error) => ({ ok: false, status, error });

/**
 * @param {{ method: string, headers: Headers, names: readonly string[], token: string }} request
 *   `names`: the listener's `host:port` names; its own origins are `http://<name>`
 * @returns {Verdict}
 */
export function checkApiRequest({ method, headers, names, token }) {
  if (!isAllowedHost(headers.get('host'), names)) return deny(403, 'unexpected Host header');
  const origin = headers.get('origin');
  if (origin !== null && !names.some((name) => origin === `http://${name}`)) return deny(403, 'cross-origin request refused');
  const site = headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') return deny(403, 'cross-site request refused');
  if (method !== 'GET' && method !== 'HEAD' && origin === null) return deny(403, 'missing Origin header');
  if (!tokensMatch(parseCookies(headers.get('cookie')).get(TOKEN_COOKIE), token)) {
    return deny(401, 'not authenticated: open the URL the daemon printed');
  }
  return { ok: true };
}
