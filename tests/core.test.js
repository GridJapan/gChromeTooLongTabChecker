import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, formatAge, HOUR } from '../src/core.js';

const now = 1_000 * HOUR;
const tab = (id, o = {}) => ({ id, windowId: 1, groupId: -1, pinned: false, discarded: false, status: 'complete', ...o });

test('時間を過ぎた読み込み済みのタブだけを、窓ごとに移す', () => {
  const tabs = [tab(1), tab(2), tab(3, { windowId: 2 }), tab(4)];
  const loadedAt = { 1: now - 25 * HOUR, 2: now - 1 * HOUR, 3: now - 30 * HOUR, 4: now - 24 * HOUR };
  const r = plan(tabs, loadedAt, now, 24, new Set());
  assert.deepEqual(r.group, { 1: [1, 4], 2: [3] });
  assert.deepEqual(r.release, []);
});

test('外れたタブ・未読み込みのタブ・ピン留め・記録の無いタブは移さない', () => {
  const tabs = [tab(1, { discarded: true }), tab(2, { status: 'unloaded' }), tab(3, { pinned: true }), tab(4)];
  const loadedAt = { 1: 0, 2: 0, 3: 0 };
  assert.deepEqual(plan(tabs, loadedAt, now, 24, new Set()).group, {});
});

test('すでに TooLong にあるタブは移し直さない', () => {
  const tabs = [tab(1, { groupId: 9 })];
  const r = plan(tabs, { 1: 0 }, now, 24, new Set([9]));
  assert.deepEqual(r, { group: {}, release: [] });
});

test('TooLong のタブが読み込み直された・外れたら、出す', () => {
  const tabs = [tab(1, { groupId: 9 }), tab(2, { groupId: 9, discarded: true }), tab(3, { groupId: 9 })];
  const loadedAt = { 1: now - 5 * 60000, 2: 0, 3: 0 };
  assert.deepEqual(plan(tabs, loadedAt, now, 24, new Set([9])).release, [1, 2]);
});

test('ほかのグループにいるタブも移す（元のグループは呼び出し側が覚える）', () => {
  const r = plan([tab(1, { groupId: 5 })], { 1: 0 }, now, 24, new Set([9]));
  assert.deepEqual(r.group, { 1: [1] });
});

test('経過時間の表示', () => {
  assert.equal(formatAge(null), '不明');
  assert.equal(formatAge(5 * 60000), '5分');
  assert.equal(formatAge(3 * HOUR + 5 * 60000), '3時間5分');
  assert.equal(formatAge(50 * HOUR), '2日2時間');
});
