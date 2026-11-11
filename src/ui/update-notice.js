/**
 * The "updated, reload" notice in the top bar: a Reload button among the top bar's own, shown
 * while the daemon serves other UI files than this page loaded (see daemon/ui-files.js), so a
 * tab left open never runs stale code unknowingly. It never reloads by itself: a reload would
 * drop an unsent draft.
 */
import { button } from './dom.js';
/** @import { DaemonClient } from '../daemon/client.js' */

/** @param {{ daemon: DaemonClient, reload?: () => void }} options */
export function createUpdateNotice({ daemon, reload = () => location.reload() }) {
  const root = button('btn btn-accent update-notice', 'Reload', () => reload());
  root.hidden = true;

  // A daemon restart reports its files on reconnect; a `git pull` under a running daemon
  // changes them silently, so ask again whenever the user comes back to the tab (while
  // connected: a page without the token, or with the daemon down, has no one to ask).
  const offChange = daemon.onUiChange((outdated) => {
    root.hidden = !outdated;
  });
  const check = () => {
    if (document.visibilityState === 'visible' && daemon.status() === 'open') void daemon.checkUi();
  };
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', check);

  return {
    root,
    destroy() {
      offChange();
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
      root.remove();
    },
  };
}
