/**
 * The form a window starts something in a directory from (an agent, a shell): a Directory field
 * that suggests folders as the path is typed, a start button, and under them the directories of
 * the latest conversations, each a click from starting there. Styled as the agent window's
 * (omp.css).
 */
import { button, el } from './dom.js';
import { errorMessage, tildeHome } from './format.js';
import { createSuggestions } from '../omp/suggestions.js';
import { createFileSuggest } from '../omp/file-suggest.js';
import { PLAIN_PATH } from '../omp/file-mention.js';
import { recentDirs } from '../omp/recent-dirs.js';
import { listConversations } from '../sessions/running.js';
/** @import { DaemonClient } from '../daemon/client.js' */

/**
 * @param {{
 *   daemon: DaemonClient,
 *   title: string,
 *   startLabel: string,
 *   recentLabel: (dir: string) => string,
 *   cwd: string | null,
 *   start: (dir: string) => Promise<void>,
 *   failed?: string | null,
 * }} options `title` heads the form and `startLabel` is its button's; `recentLabel` names a
 * recent directory's button (`dir` as shown); `cwd` is the directory it offers, else the
 * daemon's default; `start` starts in the directory picked, its failure shown under the form,
 * where `failed` says why an earlier start failed.
 * @returns {HTMLFormElement}
 */
export function directoryForm({ daemon, title, startLabel, recentLabel, cwd, start, failed = null }) {
  const form = el('form', 'omp-setup');
  const label = el('label', 'omp-label', 'Directory');
  const input = el('input', 'omp-field');
  input.type = 'text';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.placeholder = '~/code/project';
  input.id = `dir-${Math.random().toString(36).slice(2)}`;
  label.htmlFor = input.id;
  // Folders are suggested as the path is typed, read as the daemon reads a new session's
  // directory (relative to home); an empty field lists home's own folders.
  const suggestions = createSuggestions();
  const folders = createFileSuggest({
    draft: input,
    syntax: PLAIN_PATH,
    foldersOnly: true,
    // Enter starts in the folder typed; it takes a suggestion only once the arrows picked one.
    enter: 'moved',
    list: suggestions,
    listDir: (dir) => daemon.listFiles(dir),
    replace: (start, end, text) => input.setRangeText(text, start, end, 'end'),
  });
  input.addEventListener('focus', () => folders.update());
  input.addEventListener('input', () => folders.update());
  input.addEventListener('blur', () => folders.close());
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (suggestions.key(e)) {
      // Enter takes the folder and closes the list, so the next Enter starts; Tab and a click
      // go on into the folder's own folders.
      if (e.key === 'Enter') folders.close();
    } else if (e.key === 'Escape' && suggestions.open) {
      e.preventDefault();
      folders.close();
    }
  });
  if (cwd) input.value = cwd;
  else {
    // The default can arrive while the user is typing: never write over what they typed,
    // and select the default so that typing replaces it instead of appending to it.
    let typed = false;
    input.addEventListener('input', () => (typed = true), { once: true });
    daemon
      .config()
      .then((c) => {
        if (typed || input.value) return;
        input.value = c.defaultCwd;
        input.select(); // kept when the field is focused later
        folders.update();
      })
      .catch(() => {});
  }
  const submit = el('button', 'btn btn-accent', startLabel);
  submit.type = 'submit';
  const error = el('p', 'omp-error', failed ?? '');
  error.hidden = !failed;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const dir = input.value.trim();
    // One at a time: a second Enter, or a recent directory clicked, while one starts does nothing.
    if (!dir || submit.disabled) return;
    folders.close();
    submit.disabled = true;
    error.hidden = true;
    start(dir)
      .catch((err) => {
        error.textContent = errorMessage(err);
        error.hidden = false;
      })
      .finally(() => {
        submit.disabled = false;
      });
  });
  // The directories of the latest conversations, each a click from starting there, as the form
  // would with it typed. They arrive after the form is drawn, into a strip whose height is kept
  // from the start, so nothing moves and the field keeps the focus; without any, it stays empty.
  const recent = el('div', 'omp-recent');
  Promise.all([daemon.config(), daemon.history()])
    .then(([c, past]) => {
      const dirs = recentDirs(listConversations(past, daemon.sessions(), { directory: null }));
      if (!dirs.length) return;
      recent.setAttribute('role', 'group');
      recent.setAttribute('aria-label', 'Recent directories');
      const heading = el('span', 'omp-label', 'Recent');
      heading.setAttribute('aria-hidden', 'true');
      recent.append(
        heading,
        ...dirs.map((dir) => {
          const shown = tildeHome(dir, c.home);
          const pick = button('omp-tool-btn omp-recent-dir', shown, () => {
            input.value = dir;
            form.requestSubmit();
          });
          pick.setAttribute('aria-label', recentLabel(shown));
          return pick;
        }),
      );
    })
    .catch(() => {});
  // The list drops down over what is below the field, so nothing moves as it opens and closes.
  const field = el('div', 'omp-setup-field');
  field.append(input, suggestions.root);
  const row = el('div', 'omp-row');
  row.append(field, submit);
  form.append(el('p', 'omp-setup-title', title), label, row, recent, error);
  queueMicrotask(() => input.focus());
  return form;
}
