/**
 * Which browser agents drive (settings.js `browser`, picked in Setup or Config): a separate one of
 * omp's own by default, so an agent testing a page never takes over the tab its user is reading.
 *
 * omp picks a browser for its `browser` tool from its own settings (`browser.relay`, `browser.cmux`,
 * `browser.tern` in `~/.omp/agent/config.yml`) and from where it runs: inside cmux or Tern it opens
 * their web views, and with the relay on it adopts the Chrome tab its user is looking at and
 * navigates it. Each of those settings yields to an environment variable (`PI_BROWSER_RELAY`,
 * `PI_BROWSER_CMUX`, `PI_BROWSER_TERN`: `0` off, `1` on), which the daemon sets on every omp it
 * launches. A daemon started from a cmux terminal passes cmux's socket on to its omps, so without
 * `PI_BROWSER_CMUX=0` they would open their pages in that terminal's window.
 *
 * - `isolated`: omp's own Chromium (Chrome for Testing, with a profile of its own; shown or hidden
 *   as omp's `browser.headless` and the call say): relay, cmux and Tern off.
 * - `relay`: the user's own Chrome through omp's browser relay, which needs its extension
 *   (`omp browser-relay install`); an agent adopts the visible tab unless it names another.
 * - `omp`: whatever omp's own settings say; the daemon sets nothing.
 *
 * omp's `browser.cdpUrl` setting, an endpoint to attach to, is not covered by any variable: set,
 * it wins over `isolated`.
 */

/** @typedef {'isolated' | 'relay' | 'omp'} BrowserChoice */

/** The choices, as settings.js accepts them. @type {readonly BrowserChoice[]} */
export const BROWSER_CHOICES = Object.freeze(['isolated', 'relay', 'omp']);

/** @type {Readonly<Record<BrowserChoice, Readonly<Record<string, string>>>>} */
const ENV = Object.freeze({
  isolated: Object.freeze({ PI_BROWSER_RELAY: '0', PI_BROWSER_CMUX: '0', PI_BROWSER_TERN: '0' }),
  relay: Object.freeze({ PI_BROWSER_RELAY: '1' }),
  omp: Object.freeze({}),
});

/** What an omp launched for `choice` has added to its environment. @param {BrowserChoice} choice */
export const browserEnv = (choice) => ENV[choice];
