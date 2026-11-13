/**
 * The top bar's update notice: Update while Cockpit's checkout is behind the newest `main` on
 * GitHub (daemon/updates.js), else Reload while the daemon serves other UI files than this page
 * loaded (see daemon/ui-files.js), so a tab left open never runs stale code unknowingly.
 *
 * Update has the daemon fast-forward to `main` and restart, then reloads the page once the new
 * daemon answers. When the checkout cannot take the update by itself (another branch, local
 * changes or commits, new dependencies), the notice is a static "Update available" whose
 * tooltip says why, with Reload beside it while this page is outdated. Reload never happens by
 * itself: a reload would drop an unsent draft; Update is the user asking for one.
 */
import { button, el } from './dom.js';
/** @import { DaemonClient } from '../daemon/client.js' */

/** @param {number} n */
const commits = (n) => `${n} new commit${n === 1 ? '' : 's'} on main`;

/** @param {{ daemon: DaemonClient, reload?: () => void }} options */
export function createUpdateNotice({ daemon, reload = () => location.reload() }) {
  // `display: contents`: its buttons sit in the top bar as its own do.
  const root = el('span', 'update-notice');
  const reloadBtn = button('btn btn-accent', 'Reload', () => reload());
  const updateBtn = button('btn btn-accent', 'Update', () => void update());
  const infoBtn = button('btn update-info', 'Update available');
  infoBtn.setAttribute('aria-disabled', 'true');
  root.append(updateBtn, infoBtn, reloadBtn);

  let outdated = false;
  /** Asked to update, until the daemon restarts (then the page reloads) or refuses. */
  let updating = false;
  /** Why the last Update failed, as the daemon said. @type {string | null} */
  let failed = null;

  function render() {
    const state = daemon.update();
    const behind = state?.behind ?? 0;
    const blocked = behind > 0 ? (state?.blocked ?? null) : null;
    updateBtn.hidden = behind === 0 || blocked !== null;
    infoBtn.hidden = blocked === null;
    // Update reloads the page too: Reload stays only beside the static notice.
    reloadBtn.hidden = !outdated || !updateBtn.hidden;
    const busy = updating || Boolean(state?.updating);
    updateBtn.disabled = busy;
    updateBtn.textContent = busy ? 'Updating…' : 'Update';
    const error = failed ?? state?.error ?? null;
    updateBtn.title = `${commits(behind)}: update Cockpit and restart its daemon (agents working now carry on after)${error ? `\nThe last try failed: ${error}` : ''}`;
    infoBtn.title = blocked ? `${commits(behind)}, not taken from here: ${blocked}` : '';
  }

  async function update() {
    updating = true;
    failed = null;
    render();
    try {
      await daemon.applyUpdate();
    } catch (err) {
      updating = false;
      failed = err instanceof Error ? err.message : String(err);
      render();
    }
  }

  const offChange = daemon.onUiChange((next) => {
    outdated = next;
    render();
  });
  const offUpdate = daemon.onUpdate(render);
  // The daemon that took the update is gone, and its successor runs the new code: so must the page.
  const offReset = daemon.onReset(() => {
    if (updating) reload();
  });
  // A daemon restart reports its files on reconnect; a `git pull` under a running daemon
  // changes them silently, and may take the update by hand, so ask again whenever the user
  // comes back to the tab (while connected: a page without the token, or with the daemon down,
  // has no one to ask).
  const check = () => {
    if (document.visibilityState !== 'visible' || daemon.status() !== 'open') return;
    void daemon.checkUi();
    void daemon.checkUpdate();
  };
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', check);
  render();

  return {
    root,
    destroy() {
      offChange();
      offUpdate();
      offReset();
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
      root.remove();
    },
  };
}
