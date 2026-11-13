import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { pickWikiTarget } from '../daemon/vaults.js';

test('a wiki link finds its note as Obsidian does: beside the note, then from the top, then the shortest path ending in it', () => {
  const files = ['Plan.md', 'Projects/Plan.md', 'Projects/Cockpit/Plan.md', 'Archive/Old/Ideas.md', 'Inbox/Ideas.md', 'Assets/chart.png'];
  assert.equal(pickWikiTarget(files, 'Plan', 'Projects/Cockpit'), 'Projects/Cockpit/Plan.md');
  assert.equal(pickWikiTarget(files, 'Plan', 'Inbox'), 'Plan.md');
  assert.equal(pickWikiTarget(files, 'projects/plan', ''), 'Projects/Plan.md');
  assert.equal(pickWikiTarget(files, 'ideas', ''), 'Inbox/Ideas.md');
  assert.equal(pickWikiTarget(files, 'chart.png', 'Inbox'), 'Assets/chart.png');
  assert.equal(pickWikiTarget(files, 'Nowhere', ''), null);
});
