import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { isTailnetAddress } from '../daemon/remote.js';

describe('isTailnetAddress', () => {
  test('100.64.0.0/10, end to end, is the tailnet: whois is asked about these only', () => {
    for (const address of ['100.64.0.0', '100.64.0.1', '100.100.100.100', '100.127.255.255']) assert.equal(isTailnetAddress(address), true, address);
  });

  test('just outside it, and anything not an IPv4, is not', () => {
    for (const address of ['100.63.255.255', '100.128.0.0', '10.0.0.5', '192.168.1.20', '127.0.0.1', 'fd7a::1', '::ffff:100.64.0.1', '100.64.0']) {
      assert.equal(isTailnetAddress(address), false, address);
    }
  });
});
