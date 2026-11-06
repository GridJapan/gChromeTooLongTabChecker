import test from 'node:test';
import assert from 'node:assert/strict';
import { overdue, formatAge, HOUR } from '../src/core.js';

const now = 1_000 * HOUR;
const tab = (id, o = {}) => ({ id, windowId: 1, groupId: -1, pinned: false, discarded: false, status: 'complete', ...o });

test('時間を過ぎた読み込み済みのタブを、古い順に出す', () => {
  const tabs = [tab(1), tab(2), tab(3, { windowId: 2 }), tab(4)];
  const loadedAt = { 1: now - 25 * HOUR, 2: now - 1 * HOUR, 3: now - 30 * HOUR, 4: now - 24 * HOUR };
  assert.deepEqual(overdue(tabs, loadedAt, now, 24).map(r => r.tab.id), [3, 1, 4]);
  assert.equal(overdue(tabs, loadedAt, now, 24)[0].age, 30 * HOUR);
});

test('外れたタブ・未読み込みのタブ・記録の無いタブは出さない。ピン留めは出す', () => {
  const tabs = [tab(1, { discarded: true }), tab(2, { status: 'unloaded' }), tab(3, { pinned: true }), tab(4)];
  assert.deepEqual(overdue(tabs, { 1: 0, 2: 0, 3: 0 }, now, 24).map(r => r.tab.id), [3]);
});

test('経過時間の表示', () => {
  assert.equal(formatAge(null), '不明');
  assert.equal(formatAge(5 * 60000), '5分');
  assert.equal(formatAge(3 * HOUR + 5 * 60000), '3時間5分');
  assert.equal(formatAge(50 * HOUR), '2日2時間');
});
