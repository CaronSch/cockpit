/**
 * Phone access (settings.js `remote`): while it is on, the daemon also serves the owner's own
 * devices on their tailnet, through a second listener bound to the Mac's Tailscale IPv4 with the
 * same routes as loopback (server.js), behind a whois gate.
 *
 * The listener's address, names and owner come from `tailscale status --json`: Tailscale must
 * be running, and the Mac must belong to a person (a tagged node has no owner to let in). The
 * status is read again every 30 seconds while the switch is on: the listener stops while
 * Tailscale does not run, binds again when it runs again or its address changed, and a failed
 * start is retried the same way. Switched off, the listener stops with its open streams.
 *
 * The gate runs first on every request to that listener: the TCP peer's address, looked up with
 * `tailscale whois --json`, must be a device signed in as the Mac's owner and not a tagged one.
 * Anything else, a lookup that fails or takes over two seconds included, gets a plain 403 and
 * none of the app. Verdicts are kept a minute per address, and one lookup serves every request
 * waiting on it. The token is required on top, as on loopback (guard.js).
 */
import { renderSVG } from 'uqr';
/** @import { Server } from 'bun' */
/** @import { Listener } from './server.js' */
/** @import { RemoteInfo, RemoteState } from './wire.js' */
/** @import { SettingsStore } from './settings.js' */

/** How often the Tailscale status is read while Phone access is on. */
export const HEALTH_CHECK_MS = 30_000;
const WHOIS_TIMEOUT_MS = 2_000;
const VERDICT_TTL_MS = 60_000;
/** `status --json` answers at once unless something is wrong. */
const STATUS_TIMEOUT_MS = 10_000;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Whether `address` is in 100.64.0.0/10, where Tailscale gives every node its IPv4: the only
 * peers whois can name, so the only ones worth a lookup.
 * @param {string} address
 */
export function isTailnetAddress(address) {
  if (!IPV4.test(address)) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

/** The environment the Tailscale CLI runs in. @typedef {Record<string, string | undefined>} Env */
/** The Mac on its tailnet: its address, its MagicDNS name (empty without one) and its owner's login. @typedef {{ ipv4: string, dnsName: string, login: string }} Tailnet */

/**
 * Runs the Tailscale CLI; null if it cannot be started.
 * @param {string[]} argv @param {Env} env @param {number} timeoutMs
 * @returns {Promise<{ out: string, err: string, code: number } | null>}
 */
async function run(argv, env, timeoutMs) {
  try {
    const proc = Bun.spawn(argv, { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out, err, code };
  } catch {
    return null;
  }
}

/**
 * The Mac on its tailnet, from `tailscale status --json`; throws, saying why, when Phone access
 * cannot be served. Setup (setup.js) checks with it too.
 * @param {string} tailscale @param {Env} env @returns {Promise<Tailnet>}
 */
export async function readTailnet(tailscale, env) {
  const result = await run([tailscale, 'status', '--json'], env, STATUS_TIMEOUT_MS);
  if (!result) throw new Error(`Tailscale's CLI is not installed (no ${tailscale})`);
  /** @type {any} */
  let status = null;
  try {
    status = JSON.parse(result.out);
  } catch {}
  if (status?.BackendState !== 'Running') {
    const reason = typeof status?.BackendState === 'string' ? status.BackendState : result.err.trim().split('\n')[0] || `exit ${result.code}`;
    throw new Error(`Tailscale is not connected (${reason})`);
  }
  const self = status.Self;
  if (!Array.isArray(self?.TailscaleIPs)) throw new Error('Tailscale gave no address for this Mac');
  if (self.Tags !== undefined && self.Tags !== null && !(Array.isArray(self.Tags) && self.Tags.length === 0)) {
    throw new Error('This Mac is a tagged Tailscale node: it has no owner whose devices could be let in');
  }
  const ipv4 = self.TailscaleIPs.find((/** @type {unknown} */ ip) => typeof ip === 'string' && IPV4.test(ip));
  if (!ipv4) throw new Error('Tailscale gave this Mac no IPv4 address');
  const login = status.User?.[String(self.UserID)]?.LoginName;
  if (typeof login !== 'string' || !login) throw new Error('Tailscale names no owner for this Mac');
  const dnsName = typeof self.DNSName === 'string' ? self.DNSName.replace(/\.$/, '') : '';
  return { ipv4, dnsName, login };
}

/** @param {Tailnet} a @param {Tailnet} b */
const sameTailnet = (a, b) => a.ipv4 === b.ipv4 && a.dnsName === b.dnsName && a.login === b.login;

/** The names the remote listener answers to: its address, the MagicDNS name and its first label. @param {Tailnet} tailnet */
const hostsOf = ({ ipv4, dnsName }) => [...new Set([ipv4, dnsName, dnsName.split('.')[0]].filter(Boolean))];

/**
 * Who a tailnet address belongs to (`tailscale whois --json`), or null if whois does not say:
 * an address it does not know, a failure, a timeout or output it cannot read.
 * @param {string} tailscale @param {Env} env @param {string} address @param {number} timeoutMs
 * @returns {Promise<{ login: string, tagged: boolean } | null>}
 */
async function whois(tailscale, env, address, timeoutMs) {
  const result = await run([tailscale, 'whois', '--json', address], env, timeoutMs);
  if (!result || result.code !== 0) return null;
  try {
    const found = JSON.parse(result.out);
    const login = found?.UserProfile?.LoginName;
    const tags = found?.Node?.Tags;
    if (typeof login !== 'string') return null;
    return { login, tagged: !(tags === undefined || tags === null || (Array.isArray(tags) && tags.length === 0)) };
  } catch {
    return null;
  }
}

/**
 * Phone access, following the `remote` setting from now on. `serve` starts a listener with the
 * daemon's routes (server.js `createDaemon`); `port` is the remote listener's (0: any free one).
 * `env`: what the Tailscale CLI runs in; `checkEveryMs` and `whoisTimeoutMs` are shorter in tests.
 * @param {{
 *   tailscale: string, port: number, token: string, settings: Pick<SettingsStore, 'all' | 'subscribe'>,
 *   serve: (listener: Listener) => Server<undefined>, env?: Env, checkEveryMs?: number, whoisTimeoutMs?: number,
 *   now?: () => number,
 * }} options
 */
export function createRemoteAccess({ tailscale, port, token, settings, serve, env = process.env, checkEveryMs = HEALTH_CHECK_MS, whoisTimeoutMs = WHOIS_TIMEOUT_MS, now = Date.now }) {
  let on = false;
  /** @type {RemoteState} */
  let state = { state: 'off', error: null };
  /** The listener serving now, and the tailnet it was bound for. @type {{ server: Server<undefined>, tailnet: Tailnet } | null} */
  let live = null;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let timer;
  /** Checks run one at a time. @type {Promise<void>} */
  let queue = Promise.resolve();
  /** Each address's verdict, allow or deny, and when it was asked for. @type {Map<string, { at: number, allowed: Promise<boolean> }>} */
  const verdicts = new Map();
  /** @type {Set<(state: RemoteState) => void>} */
  const listeners = new Set();

  /** @param {RemoteState['state']} next @param {string | null} [error] */
  function setState(next, error = null) {
    if (state.state === next && state.error === error) return;
    state = { state: next, error };
    for (const fn of listeners) fn(state);
  }

  function close() {
    if (!live) return;
    void live.server.stop(true);
    live = null;
    verdicts.clear();
  }

  /**
   * Whether the request comes from one of the owner's own devices: the gate before anything else.
   * @param {Request} req @param {Server<undefined>} server @returns {Promise<boolean>}
   */
  function admit(req, server) {
    const address = server.requestIP(req)?.address;
    if (!address || !live) return Promise.resolve(false);
    // A peer outside the tailnet's range (a LAN host routing to this address) costs no lookup and
    // no cache entry; the listener's own address is the Mac itself.
    if (address !== live.tailnet.ipv4 && !isTailnetAddress(address)) return Promise.resolve(false);
    const owner = live.tailnet.login;
    const at = now();
    const known = verdicts.get(address);
    if (known && at - known.at < VERDICT_TTL_MS) return known.allowed;
    for (const [key, old] of verdicts) if (at - old.at >= VERDICT_TTL_MS) verdicts.delete(key);
    const allowed = whois(tailscale, env, address, whoisTimeoutMs).then((peer) => peer !== null && peer.login === owner && !peer.tagged);
    verdicts.set(address, { at, allowed });
    return allowed;
  }

  /** Brings the listener in line with Tailscale's status: serving on the Mac's address while it runs. */
  async function check() {
    if (!on) return;
    /** @type {Tailnet} */
    let tailnet;
    try {
      tailnet = await readTailnet(tailscale, env);
    } catch (err) {
      if (!on) return;
      close();
      return setState('error', err instanceof Error ? err.message : String(err));
    }
    if (!on) return;
    if (live && sameTailnet(live.tailnet, tailnet)) return setState('on');
    close();
    try {
      live = { server: serve({ hostname: tailnet.ipv4, port, hosts: hostsOf(tailnet), admit, remote: true }), tailnet };
      setState('on');
    } catch (err) {
      setState('error', `Could not listen on ${tailnet.ipv4}:${port}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const recheck = () => (queue = queue.then(check));

  /** Switches Phone access on or off; resolves once the listener is up (or why not is known). @param {boolean} value */
  function set(value) {
    if (value === on) return queue;
    on = value;
    if (on) {
      setState('starting');
      timer = setInterval(recheck, checkEveryMs);
      return recheck();
    }
    clearInterval(timer);
    timer = undefined;
    close();
    setState('off');
    return queue;
  }

  const unsubscribe = settings.subscribe((all) => void set(all.remote));
  void set(settings.all().remote);

  return {
    /** How Phone access is now. @returns {RemoteState} */
    state: () => state,
    /** Hears every change of state. @param {(state: RemoteState) => void} fn */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** The state, and while on the phone's URL, the owner's login and the sign-in QR code. @returns {RemoteInfo} */
    info() {
      if (state.state !== 'on' || !live) return { ...state, url: null, login: null, qr: null };
      const url = `http://${live.tailnet.ipv4}:${live.server.port}/phone`;
      return { ...state, url, login: live.tailnet.login, qr: renderSVG(`${url}?token=${token}`) };
    },
    /** Waits for the checks under way: the listener is as the setting and Tailscale say. */
    settled: () => queue,
    /** Stops following the setting and closes the listener (the daemon exits). */
    stop() {
      unsubscribe();
      return set(false);
    },
  };
}

/** @typedef {ReturnType<typeof createRemoteAccess>} RemoteAccess */
