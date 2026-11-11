/**
 * Notes beside the agents: text with screenshots and files in it, filling its window. Each new
 * Notes window (or the + after its title, a tab beside it) starts its own pad, named in the
 * window's title by its first line; All notes, in the title bar, reopens any pad (two windows may
 * show the same one), starts another or deletes this one.
 *
 * A pad is a Markdown file the daemon keeps (`~/.cockpit/scratchpads/<id>.md`), so
 * closing a window loses nothing. Pasted or dropped files are stored beside it and shown
 * inline between text blocks (see `scratchpad/blocks.js`).
 */
import { button, carriesFiles, el } from '../ui/dom.js';
import { errorMessage, tildeHome } from '../ui/format.js';
import { autosize } from '../ui/autosize.js';
import { tabIndent } from '../ui/indent.js';
import { onZoom } from '../ui/zoom.js';
import { getDaemon } from '../daemon/client.js';
import { getScratchpad } from '../scratchpad/store.js';
import { IMAGE_TYPES, DEFAULT_PAD, PAD_ID, assetUrl, insertAsset, parseBlocks, serializeBlocks, titleOf, withGaps } from '../scratchpad/blocks.js';
import { opensInViewer } from '../ui/image-viewer.js';
/** @import { WidgetContext } from './registry.js' */
/** @import { DaemonClient } from '../daemon/client.js' */
/** @import { ScratchpadStore } from '../scratchpad/store.js' */
/** @import { Block } from '../scratchpad/blocks.js' */
/** @import { ScratchpadSummary } from '../../daemon/wire.js' */

/** Image types shown inline, to the extension a file of that type is stored under (the first listed). */
const INLINE_IMAGES = /** @type {Record<string, string>} */ (
  Object.fromEntries(Object.entries(IMAGE_TYPES).reverse().map(([ext, type]) => [type, ext]))
);

const newPadId = () => crypto.randomUUID().slice(0, 8);

export default {
  type: 'scratchpad',
  title: 'Notes',
  glyph: '✎',
  description: 'Notes with screenshots and files; each new window starts a fresh page',
  newParams: () => ({ pad: newPadId() }),
  /** The + after its title: fresh notes as a tab beside it. */
  newTab: () => ({ pad: newPadId() }),

  /** @param {HTMLElement} body @param {WidgetContext} ctx */
  mount(body, ctx) {
    return createScratchpadWindow(body, ctx, getDaemon());
  },
};

/** A name the daemon will serve the way the file is meant to be shown. @param {File} file */
function fileName(file) {
  const ext = INLINE_IMAGES[file.type];
  const name = file.name || (ext ? 'screenshot' : 'file');
  return ext && !name.toLowerCase().endsWith(ext) && !(ext === '.jpg' && /\.jpe?g$/i.test(name)) ? `${name}${ext}` : name;
}

/** @param {HTMLElement} body @param {WidgetContext} ctx @param {DaemonClient} daemon */
function createScratchpadWindow(body, ctx, daemon) {
  const padId = () => (typeof ctx.params.pad === 'string' && PAD_ID.test(ctx.params.pad) ? ctx.params.pad : DEFAULT_PAD);

  const root = el('div', 'scratchpad');

  // ── pad switcher, in the window's title bar ──
  const switcher = button('omp-tool-btn pad-switch', 'All notes');
  switcher.setAttribute('aria-haspopup', 'menu');
  const menu = el('div', 'pad-menu');
  menu.setAttribute('role', 'menu');
  menu.popover = 'auto';
  switcher.popoverTargetElement = menu;
  ctx.headActions.append(switcher, menu);

  // ── conflict ──
  const conflict = el('div', 'scratchpad-conflict');
  conflict.setAttribute('role', 'alert');
  const keepMine = button('btn btn-accent', 'Keep mine');
  const takeTheirs = button('btn', 'Use theirs');
  const conflictActions = el('div', 'scratchpad-row');
  conflictActions.append(keepMine, takeTheirs);
  const theirsView = el('details', 'scratchpad-theirs');
  const theirsText = el('pre', '');
  theirsView.append(el('summary', '', 'Show their version'), theirsText);
  conflict.append(
    el('p', '', 'These notes were changed somewhere else (another tab, or the file itself) while you were typing.'),
    theirsView,
    conflictActions,
  );

  // ── document ──
  const doc = el('div', 'pad-doc');
  const footer = el('div', 'scratchpad-footer');
  const status = el('span', 'scratchpad-status');
  status.setAttribute('aria-live', 'polite');
  const where = el('span', 'scratchpad-file');
  footer.append(status, where);
  root.append(conflict, doc, footer);
  body.append(root);

  /** @type {ScratchpadStore} */
  let store = getScratchpad(padId());
  let off = store.subscribe(draw);
  /** The rendered blocks, gaps included; edits change them in place. @type {Block[]} */
  let blocks = [];
  /** The pad text the blocks were last rendered from (or typed into). @type {string | null} */
  let rendered = null;
  /** What an upload in progress is doing, shown instead of the save status. @type {string | null} */
  let busy = null;
  /** @type {{ dir: string, home: string } | null} */
  let paths = null;

  daemon
    .config()
    .then(({ scratchpadDir, home }) => {
      paths = { dir: scratchpadDir, home };
      draw();
    })
    .catch(() => {});

  /** @param {Block} block @param {number} index @param {boolean} onlyBlock */
  function renderBlock(block, index, onlyBlock) {
    if (block.kind === 'text') {
      const area = el('textarea', 'pad-text');
      area.rows = 1;
      area.spellcheck = false;
      area.value = block.text;
      area.dataset.index = String(index);
      area.setAttribute('aria-label', 'Notes text');
      if (onlyBlock) area.placeholder = 'Notes, links, commands… Paste a screenshot or drop a file to add it.';
      return area;
    }
    const url = assetUrl(block.path);
    const box = el('div', block.kind === 'image' ? 'pad-image' : 'pad-file');
    box.dataset.index = String(index);
    const link = el('a', '');
    link.href = url;
    if (block.kind === 'image') {
      link.target = '_blank';
      link.rel = 'noopener';
      const img = el('img', '');
      img.src = url;
      img.alt = block.name;
      img.loading = 'lazy';
      link.append(img);
      opensInViewer(/** @type {HTMLAnchorElement} */ (link), block.name);
    } else {
      link.download = block.name;
      link.textContent = block.name;
    }
    const remove = button('pad-remove', '×');
    remove.setAttribute('aria-label', `Remove ${block.name}`);
    box.append(link, remove);
    return box;
  }

  const textAreas = () => /** @type {HTMLTextAreaElement[]} */ ([...doc.querySelectorAll('textarea.pad-text')]);
  const sizeAll = () => {
    for (const area of textAreas()) autosize(area, { scroller: doc });
  };

  /** Rebuilds the blocks from `text`, keeping the caret where it was if possible. @param {string} text */
  function renderDoc(text) {
    const active = /** @type {HTMLTextAreaElement | null} */ (doc.contains(document.activeElement) ? document.activeElement : null);
    const caret = active?.classList.contains('pad-text')
      ? { index: Number(active.dataset.index), start: active.selectionStart, end: active.selectionEnd }
      : null;
    blocks = withGaps(parseBlocks(text));
    doc.replaceChildren(...blocks.map((b, i) => renderBlock(b, i, blocks.length === 1)));
    rendered = text;
    sizeAll();
    if (caret) {
      const area = /** @type {HTMLTextAreaElement | undefined} */ (textAreas().find((a) => Number(a.dataset.index) >= caret.index) ?? textAreas().at(-1));
      area?.focus();
      area?.setSelectionRange(Math.min(caret.start, area.value.length), Math.min(caret.end, area.value.length));
    }
  }

  /** @param {Block[]} next */
  function commit(next) {
    const text = serializeBlocks(next);
    rendered = null; // the structure changed: render it from the store's text
    store.edit(text);
    if (rendered === null) renderDoc(text); // the store had this text already: nothing redrew
  }

  function draw() {
    const s = store.state();
    if (s.text !== rendered) renderDoc(s.text);
    for (const area of textAreas()) area.readOnly = s.phase === 'loading';
    ctx.setLabel(titleOf(s.text) || null);
    conflict.hidden = s.phase !== 'conflict';
    theirsText.textContent = s.theirs ? s.theirs.text || '(empty)' : '';
    status.classList.toggle('is-error', !busy && s.phase === 'error');
    status.textContent =
      busy ??
      {
        loading: s.error ? `Waiting for the daemon: ${s.error}` : 'Loading…',
        saved: 'Saved',
        saving: 'Saving…',
        error: `Not saved: ${s.error}. Retrying when the daemon is back.`,
        conflict: 'Not saved: choose a version above',
      }[s.phase];
    if (paths) {
      const file = `${paths.dir}/${padId()}.md`;
      where.textContent = tildeHome(file, paths.home);
    }
  }

  /** Shows pad `id` in this window. @param {string} id */
  function showPad(id) {
    menu.hidePopover();
    if (id === padId()) return;
    ctx.setParams({ pad: id });
    off();
    store = getScratchpad(padId());
    off = store.subscribe(draw);
    rendered = null;
    draw();
  }

  // ── files ──
  /**
   * Stores each file beside the pad and puts it into text block `index` at `caret`, in order.
   * @param {File[]} files @param {number} index @param {number} caret
   */
  async function addFiles(files, index, caret) {
    const pad = padId();
    let at = { index, caret };
    for (const file of files) {
      const name = fileName(file);
      busy = `Adding ${name}…`;
      draw();
      try {
        const path = await daemon.uploadScratchpadFile(pad, file, name);
        if (padId() !== pad) break; // the window moved on to another pad meanwhile
        const kind = INLINE_IMAGES[file.type] ? 'image' : 'file';
        blocks = insertAsset(blocks, at.index, at.caret, { kind, name, path });
        at = { index: at.index + 2, caret: 0 }; // the text after the file just added
        busy = null;
        commit(blocks);
      } catch (err) {
        busy = `Could not add ${name}: ${errorMessage(err)}`;
        draw();
        return;
      }
    }
    busy = null;
    draw();
  }

  /** Where typing would go: the caret of a focused text block, else the end of the pad. */
  function insertionPoint() {
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement && doc.contains(active)) {
      return { index: Number(active.dataset.index), caret: active.selectionStart };
    }
    const last = blocks.length - 1;
    const lastBlock = blocks[last];
    return { index: last, caret: lastBlock?.kind === 'text' ? lastBlock.text.length : 0 };
  }

  doc.addEventListener('input', (event) => {
    const area = /** @type {HTMLTextAreaElement} */ (event.target);
    if (!area.classList.contains('pad-text')) return;
    blocks[Number(area.dataset.index)] = { kind: 'text', text: area.value };
    autosize(area, { scroller: doc });
    rendered = serializeBlocks(blocks);
    store.edit(rendered);
  });
  doc.addEventListener('paste', (event) => {
    const area = /** @type {HTMLElement} */ (event.target);
    const files = [...(event.clipboardData?.files ?? [])];
    if (!area.classList.contains('pad-text') || files.length === 0) return;
    event.preventDefault();
    void addFiles(files, Number(area.dataset.index), /** @type {HTMLTextAreaElement} */ (area).selectionStart);
  });
  // Where the last press began: a drag that selects text and is let go below it ends in a click
  // on the pad itself, which must not move the caret away from the selection.
  let pressedOnPad = false;
  doc.addEventListener('pointerdown', (event) => {
    pressedOnPad = event.target === doc;
  });
  doc.addEventListener('click', (event) => {
    if (event.target === doc) {
      if (!pressedOnPad) return;
      // A click below the last block types at the end, as in any editor.
      const last = textAreas().at(-1);
      last?.focus();
      last?.setSelectionRange(last.value.length, last.value.length);
      return;
    }
    const remove = /** @type {Element} */ (event.target).closest('.pad-remove');
    const box = /** @type {HTMLElement | null} */ (remove?.parentElement ?? null);
    if (!box) return;
    commit(blocks.filter((_, i) => i !== Number(box.dataset.index)));
  });
  tabIndent(doc);
  root.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 's') {
      event.preventDefault();
      void store.flush();
    }
  });

  root.addEventListener('dragover', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    root.classList.add('is-drop-target');
  });
  root.addEventListener('dragleave', (event) => {
    if (!root.contains(/** @type {Node | null} */ (event.relatedTarget))) root.classList.remove('is-drop-target');
  });
  root.addEventListener('drop', (event) => {
    root.classList.remove('is-drop-target');
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length === 0) return;
    event.preventDefault();
    const { index, caret } = insertionPoint();
    void addFiles(files, index, caret);
  });

  keepMine.addEventListener('click', () => store.keepMine());
  takeTheirs.addEventListener('click', () => store.takeTheirs());

  // ── switcher menu ──
  /** @param {string} label @param {string} [detail] */
  function menuItem(label, detail) {
    const item = button('pad-menu-item');
    item.setAttribute('role', 'menuitem');
    item.append(el('span', 'pad-menu-label', label));
    if (detail) item.append(el('span', 'pad-menu-detail', detail));
    return item;
  }

  /** @param {ScratchpadSummary[]} pads */
  function fillMenu(pads) {
    const current = padId();
    const listed = pads.some((p) => p.id === current);
    const items = [];
    if (!listed) items.push({ id: current, title: titleOf(store.state().text), modifiedAt: null });
    items.push(...pads);
    menu.replaceChildren();
    for (const pad of items) {
      const when = pad.modifiedAt === null ? 'not saved yet' : new Date(pad.modifiedAt).toLocaleString();
      const item = menuItem(pad.title || 'Untitled', when);
      if (pad.id === current) item.setAttribute('aria-current', 'true');
      item.addEventListener('click', () => showPad(pad.id));
      menu.append(item);
    }
    menu.append(el('div', 'pad-menu-sep'));
    const fresh = menuItem('New notes');
    fresh.addEventListener('click', () => showPad(newPadId()));
    menu.append(fresh);
    if (listed) {
      const remove = menuItem('Delete these notes…');
      remove.classList.add('is-danger');
      remove.addEventListener('click', confirmDelete);
      menu.append(remove);
    }
  }

  function confirmDelete() {
    const id = padId();
    const title = titleOf(store.state().text) || 'Untitled';
    const yes = button('btn btn-danger', 'Delete');
    const no = button('btn', 'Cancel');
    const actions = el('div', 'scratchpad-row');
    actions.append(yes, no);
    menu.replaceChildren(el('p', 'pad-menu-confirm', `Delete “${title}” and its files, for every window showing it?`), actions);
    no.addEventListener('click', () => menu.hidePopover());
    yes.addEventListener('click', () => {
      daemon
        .deleteScratchpad(id)
        .then(() => showPad(newPadId()))
        .catch((err) => {
          busy = `Could not delete: ${errorMessage(err)}`;
          menu.hidePopover();
          draw();
        });
    });
    yes.focus();
  }

  menu.addEventListener('toggle', (event) => {
    if (/** @type {ToggleEvent} */ (event).newState !== 'open') return;
    menu.replaceChildren(el('p', 'pad-menu-confirm', 'Loading…'));
    daemon
      .scratchpads()
      .then((pads) => {
        if (!menu.matches(':popover-open')) return;
        fillMenu(pads);
        /** @type {HTMLElement | null} */ (menu.querySelector('[aria-current="true"]') ?? menu.querySelector('.pad-menu-item'))?.focus();
      })
      .catch((err) => menu.replaceChildren(el('p', 'pad-menu-confirm', `Could not list notes: ${errorMessage(err)}`)));
  });
  menu.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = /** @type {HTMLElement[]} */ ([...menu.querySelectorAll('button')]);
    const at = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  });

  const resize = new ResizeObserver(sizeAll);
  resize.observe(doc);
  const offZoom = onZoom(sizeAll);
  draw();

  return {
    destroy() {
      // The store is the page's, not this window's: it still saves anything typed here.
      off();
      resize.disconnect();
      offZoom();
      ctx.headActions.replaceChildren();
      root.remove();
    },
  };
}
