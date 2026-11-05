// background.js を、作り物の chrome.* の上で動かして確かめる
import test from 'node:test';
import assert from 'node:assert/strict';
import { HOUR } from '../src/core.js';

const ev = () => { const fns = []; return { addListener: f => fns.push(f), fire: (...a) => Promise.all(fns.map(f => f(...a))) }; };

function fakeChrome() {
  const store = { session: {}, sync: {} };
  const area = name => ({
    get: async def => ({ ...structuredClone(def), ...structuredClone(store[name]) }),
    set: async o => { Object.assign(store[name], structuredClone(o)); },
  });
  const w = {
    tabs: [], groups: [], nextGroup: 100, badge: '', host: false,
  };
  const c = {
    _w: w, _store: store,
    storage: { session: area('session'), sync: area('sync') },
    tabs: {
      query: async () => structuredClone(w.tabs),
      get: async id => structuredClone(w.tabs.find(t => t.id === id)),
      group: async ({ groupId, tabIds, createProperties }) => {
        let g = groupId;
        if (g === undefined) { g = w.nextGroup++; w.groups.push({ id: g, windowId: createProperties.windowId, title: '' }); }
        for (const t of w.tabs) if (tabIds.includes(t.id)) t.groupId = g;
        return g;
      },
      ungroup: async id => { w.tabs.find(t => t.id === id).groupId = -1; },
      onReplaced: ev(), onRemoved: ev(),
    },
    tabGroups: {
      query: async ({ title, windowId }) => w.groups.filter(g => g.title === title && (windowId === undefined || g.windowId === windowId) && w.tabs.some(t => t.groupId === g.id)),
      get: async id => { const g = w.groups.find(g => g.id === id && w.tabs.some(t => t.groupId === g.id)); if (!g) throw new Error('no group'); return structuredClone(g); },
      update: async (id, p) => Object.assign(w.groups.find(g => g.id === id), p),
    },
    webNavigation: { onCommitted: ev() },
    permissions: { contains: async () => w.host },
    scripting: { executeScript: async () => [{ result: Date.now() - 48 * HOUR }] },
    alarms: { create: () => {}, onAlarm: ev() },
    runtime: { onInstalled: ev(), onStartup: ev(), onMessage: ev() },
    action: { setBadgeText: async ({ text }) => { w.badge = text; }, setBadgeBackgroundColor: async () => {} },
  };
  return c;
}

const send = (c, msg) => new Promise(res => c.runtime.onMessage.fire(msg, {}, res));
const tab = (id, o = {}) => ({ id, windowId: 1, groupId: -1, pinned: false, discarded: false, status: 'complete', url: 'https://example.com/', ...o });

const chrome = fakeChrome();
globalThis.chrome = chrome;
await import('../src/background.js');
const w = chrome._w;

test('読み込んだ時刻を覚え、時間を過ぎたら TooLong を作って入れる。元のグループを覚える', async () => {
  w.groups.push({ id: 5, windowId: 1, title: '仕事', color: 'blue' });
  w.tabs = [tab(1, { groupId: 5 }), tab(2), tab(3, { windowId: 2 })];
  await chrome.storage.sync.set({ hours: 24 });
  const old = Date.now() - 30 * HOUR;
  await chrome.webNavigation.onCommitted.fire({ frameId: 0, tabId: 1, timeStamp: old });
  await chrome.webNavigation.onCommitted.fire({ frameId: 0, tabId: 3, timeStamp: old });
  await chrome.webNavigation.onCommitted.fire({ frameId: 0, tabId: 2, timeStamp: Date.now() });
  await chrome.webNavigation.onCommitted.fire({ frameId: 1, tabId: 2, timeStamp: old }); // iframe は数えない
  assert.deepEqual(await send(chrome, { type: 'check' }), { ok: true });

  const tl = w.groups.filter(g => g.title === 'TooLong');
  assert.equal(tl.length, 2, '窓ごとに 1 つ');
  assert.equal(w.tabs[0].groupId, tl.find(g => g.windowId === 1).id);
  assert.equal(w.tabs[1].groupId, -1);
  assert.equal(w.tabs[2].groupId, tl.find(g => g.windowId === 2).id);
  assert.deepEqual(chrome._store.session.origGroup[1], { id: 5, title: '仕事', color: 'blue' });
  assert.equal(w.badge, '2');
});

test('2 回目の確認で同じ窓の TooLong を使い回す', async () => {
  const before = w.groups.length;
  w.tabs.push(tab(4));
  await chrome.webNavigation.onCommitted.fire({ frameId: 0, tabId: 4, timeStamp: Date.now() - 25 * HOUR });
  await send(chrome, { type: 'check' });
  assert.equal(w.groups.length, before);
  assert.equal(w.tabs[3].groupId, w.tabs[0].groupId);
});

test('読み込み直したタブは元のグループへ戻る。グループが空になって消えていれば作り直す。元が無ければグループから出る', async () => {
  await chrome.webNavigation.onCommitted.fire({ frameId: 0, tabId: 1, timeStamp: Date.now() });
  await chrome.webNavigation.onCommitted.fire({ frameId: 0, tabId: 4, timeStamp: Date.now() });
  await send(chrome, { type: 'check' });
  const g = w.groups.find(g => g.id === w.tabs[0].groupId);
  assert.equal(g.title, '仕事');
  assert.equal(g.color, 'blue');
  assert.equal(w.tabs[3].groupId, -1);
  assert.equal(chrome._store.session.origGroup[1], undefined);
});

test('外れたタブは TooLong から出る。id が替わっても記録を引き継ぐ', async () => {
  w.tabs[2].discarded = true;
  await send(chrome, { type: 'check' });
  assert.equal(w.tabs[2].groupId, -1);

  const t = chrome._store.session.loadedAt[3];
  w.tabs[2].id = 33;
  await chrome.tabs.onReplaced.fire(33, 3);
  assert.equal(chrome._store.session.loadedAt[33], t);
  assert.equal(chrome._store.session.loadedAt[3], undefined);
});

test('記録の無いタブ: 許可が無ければ今から数え、許可があればページの読み込み時刻を読む', async () => {
  w.tabs = [tab(10)];
  await send(chrome, { type: 'check' });
  assert.equal(w.tabs[0].groupId, -1);

  w.host = true;
  await send(chrome, { type: 'forget' });
  assert.ok(w.tabs[0].groupId !== -1, '48 時間前に読み込んだと読めたので移る');
});

test('閉じたタブの記録を消す', async () => {
  await chrome.tabs.onRemoved.fire(10);
  assert.equal(chrome._store.session.loadedAt[10], undefined);
});
