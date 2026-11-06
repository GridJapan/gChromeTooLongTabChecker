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
    remove: async k => { for (const x of [].concat(k)) delete store[name][x]; },
  });
  const w = { tabs: [], groups: [], nextGroup: 100, badge: '', host: false, heap: {} };
  const alive = g => w.tabs.some(t => t.groupId === g.id);
  const c = {
    _w: w, _store: store,
    storage: { session: area('session'), sync: area('sync') },
    tabs: {
      query: async (q = {}) => structuredClone(w.tabs.filter(t => q.groupId === undefined || t.groupId === q.groupId)),
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
      query: async ({ title, windowId }) => w.groups.filter(g => g.title === title && (windowId === undefined || g.windowId === windowId) && alive(g)),
      get: async id => { const g = w.groups.find(g => g.id === id && alive(g)); if (!g) throw new Error('no group'); return structuredClone(g); },
      update: async (id, p) => Object.assign(w.groups.find(g => g.id === id), p),
    },
    windows: { getAll: async () => [...new Set(w.tabs.map(t => t.windowId))].map(id => ({ id })) },
    webNavigation: { onCommitted: ev() },
    permissions: { contains: async () => w.host },
    // 読み込んだ時刻を聞かれたら 48 時間前、メモリを聞かれたら w.heap の値を返す
    scripting: { executeScript: async ({ target, func }) => [{ result: String(func).includes('memory') ? (w.heap[target.tabId] ?? null) : Date.now() - 48 * HOUR }] },
    alarms: { create: () => {}, onAlarm: ev() },
    runtime: { onInstalled: ev(), onStartup: ev(), onMessage: ev() },
    action: { setBadgeText: async ({ text }) => { w.badge = text; }, setBadgeBackgroundColor: async () => {} },
  };
  return c;
}

const send = (c, msg) => new Promise(res => c.runtime.onMessage.fire(msg, {}, res));
// 5 分ごとの確認を鳴らし、終わるまで待つ（処理は順番待ちなので、あとの check が返れば終わっている）
const tick = async c => { await c.alarms.onAlarm.fire({ name: 'toolong-check' }); await send(c, { type: 'check' }); };
const tab = (id, o = {}) => ({ id, windowId: 1, groupId: -1, pinned: false, discarded: false, status: 'complete', url: 'https://example.com/', ...o });

const chrome = fakeChrome();
globalThis.chrome = chrome;
await import('../src/background.js');
const w = chrome._w;

test('読み込んだ時刻を覚え、時間を過ぎたタブの数をアイコンに出す。グループには触らない', async () => {
  w.tabs = [tab(1), tab(2), tab(3, { windowId: 2 })];
  await chrome.storage.sync.set({ hours: 24 });
  const old = Date.now() - 30 * HOUR;
  await chrome.webNavigation.onCommitted.fire({ frameId: 0, tabId: 1, timeStamp: old });
  await chrome.webNavigation.onCommitted.fire({ frameId: 0, tabId: 3, timeStamp: old });
  await chrome.webNavigation.onCommitted.fire({ frameId: 0, tabId: 2, timeStamp: Date.now() });
  await chrome.webNavigation.onCommitted.fire({ frameId: 1, tabId: 2, timeStamp: old }); // iframe は数えない
  const st = await send(chrome, { type: 'status' });
  assert.equal(w.badge, '2');
  assert.deepEqual(st.windows, [1, 2]);
  assert.equal(st.loadedAt[1], Math.round(old));
  assert.ok(w.tabs.every(t => t.groupId === -1));
});

test('読み込み直すと数え直す。外れたタブは数えない', async () => {
  await chrome.webNavigation.onCommitted.fire({ frameId: 0, tabId: 1, timeStamp: Date.now() });
  w.tabs[2].discarded = true;
  await send(chrome, { type: 'check' });
  assert.equal(w.badge, '');
});

test('id が替わっても記録を引き継ぎ、閉じたタブの記録を消す', async () => {
  const t = chrome._store.session.loadedAt[3];
  w.tabs[2].id = 33;
  await chrome.tabs.onReplaced.fire(33, 3);
  assert.equal(chrome._store.session.loadedAt[33], t);
  assert.equal(chrome._store.session.loadedAt[3], undefined);
  await chrome.tabs.onRemoved.fire(33);
  assert.equal(chrome._store.session.loadedAt[33], undefined);
});

test('記録の無いタブ: 許可が無ければ今から数え、許可があればページの読み込み時刻を読む', async () => {
  w.tabs = [tab(10)];
  await send(chrome, { type: 'check' });
  assert.equal(w.badge, '');
  w.host = true;
  await send(chrome, { type: 'forget' });
  assert.equal(w.badge, '1', '48 時間前に読み込んだと読めた');
  w.host = false;
});

test('入れたとき（更新でも入れ直しでも）、0.1.0 の TooLong グループを片付けて元のグループへ戻す', async () => {
  // 0.1.0 の状態: タブ 20・21 を TooLong へ移していた。20 は「仕事」（もう消えた）から、21 はグループ無しから
  w.tabs = [tab(20, { groupId: 7 }), tab(21, { groupId: 7 }), tab(22)];
  w.groups.push({ id: 7, windowId: 1, title: 'TooLong', color: 'red' });
  await chrome.storage.session.set({ origGroup: { 20: { id: 5, title: '仕事', color: 'blue' } } });
  await chrome.storage.sync.set({ color: 'red', restore: true });
  await chrome.runtime.onInstalled.fire({ reason: 'install' });
  await send(chrome, { type: 'check' });   // 片付けが終わるのを待つ

  const g20 = w.groups.find(g => g.id === w.tabs[0].groupId);
  assert.deepEqual([g20.title, g20.color], ['仕事', 'blue']);
  assert.equal(w.tabs[1].groupId, -1);
  assert.equal(chrome._store.session.origGroup, undefined);
  assert.equal(chrome._store.sync.color, undefined);
});

test('許可があれば、メモリを測って最初・今・最低・最高を記録する。読み込み直したら測り直す', async () => {
  const MB = 1048576;
  w.groups = [];
  w.tabs = [tab(40), tab(41, { url: 'chrome://newtab/' }), tab(42, { discarded: true })];
  w.host = true;
  w.heap = { 40: 100 * MB, 41: 5 * MB, 42: 5 * MB };
  await chrome.runtime.onInstalled.fire({ reason: 'install' });
  await send(chrome, { type: 'check' });
  w.heap[40] = 60 * MB;
  await tick(chrome);
  w.heap[40] = 250 * MB;
  await tick(chrome);
  const st = await send(chrome, { type: 'status' });
  const r = st.mem[40];
  assert.deepEqual([r.v0, r.v, r.min, r.max], [100 * MB, 250 * MB, 60 * MB, 250 * MB]);
  assert.equal(st.mem[41], undefined, 'chrome:// は測らない');
  assert.equal(st.mem[42], undefined, '外れたタブは測らない');
  assert.equal(st.canRead, true);

  await chrome.webNavigation.onCommitted.fire({ frameId: 0, tabId: 40, timeStamp: Date.now() });
  assert.equal(chrome._store.session.mem[40], undefined);
  w.host = false;
});

test('許可が無ければメモリは測らない', async () => {
  w.tabs = [tab(50)];
  w.heap = { 50: 10 * 1048576 };
  await tick(chrome);
  const st = await send(chrome, { type: 'status' });
  assert.equal(st.mem[50], undefined);
  assert.equal(st.canRead, false);
});
