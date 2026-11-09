#!/usr/bin/env bun
/**
 * Scripted stand-in for Tailscale's CLI (`tailscale`), for daemon and browser tests of Phone
 * access (daemon/remote.js): it answers `status --json` and `whois --json <address>` in the
 * shapes of Tailscale 1.104, in the fields the daemon reads.
 *
 * - `status --json` prints `$FAKE_TAILSCALE_STATUS_FILE`'s contents (re-read on every call, so a
 *   test can stop and start "Tailscale"), else `$FAKE_TAILSCALE_STATUS`, else a running node
 *   at 127.0.0.1 named mac.example.ts.net, owned by owner@example.com.
 * - `whois --json <address>` looks the address up in `$FAKE_TAILSCALE_PEERS` (JSON:
 *   `{ "<address>": { "login": string, "tags"?: string[] } }`, by default 127.0.0.1 is the
 *   owner's) and prints who it is; an address not there fails as the real CLI does, with
 *   `peer not found` and exit 1. `$FAKE_TAILSCALE_WHOIS_DELAY_MS` makes it answer that late.
 * - `$FAKE_TAILSCALE_LOG`, when set, names a file each call appends its arguments to, one line
 *   per call, so a test can count the lookups.
 */
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_TAILSCALE_LOG) appendFileSync(process.env.FAKE_TAILSCALE_LOG, `${args.join(' ')}\n`);

const DEFAULT_STATUS = {
  BackendState: 'Running',
  Self: { TailscaleIPs: ['127.0.0.1', 'fd7a::1'], DNSName: 'mac.example.ts.net.', UserID: 1 },
  User: { 1: { LoginName: 'owner@example.com', DisplayName: 'Owner' } },
};
const DEFAULT_PEERS = { '127.0.0.1': { login: 'owner@example.com' } };

/** @param {string} message @returns {never} */
function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (args[0] === 'status' && args[1] === '--json') {
  const file = process.env.FAKE_TAILSCALE_STATUS_FILE;
  process.stdout.write(file ? readFileSync(file, 'utf8') : (process.env.FAKE_TAILSCALE_STATUS ?? JSON.stringify(DEFAULT_STATUS)));
} else if (args[0] === 'whois' && args[1] === '--json' && args[2]) {
  const delay = Number(process.env.FAKE_TAILSCALE_WHOIS_DELAY_MS);
  if (delay > 0) await Bun.sleep(delay);
  /** @type {Record<string, { login: string, tags?: string[] }>} */
  const peers = process.env.FAKE_TAILSCALE_PEERS ? JSON.parse(process.env.FAKE_TAILSCALE_PEERS) : DEFAULT_PEERS;
  const peer = peers[args[2]] ?? fail('peer not found');
  const node = { Name: `${peer.login.split('@')[0]}-device.example.ts.net.`, ...(peer.tags ? { Tags: peer.tags } : {}) };
  process.stdout.write(JSON.stringify({ Node: node, UserProfile: { LoginName: peer.login, DisplayName: peer.login.split('@')[0] } }));
} else {
  fail(`fake tailscale: unknown command: ${args.join(' ')}`);
}
