// タブを読み込んだ時刻を覚え、決めた時間を過ぎたタブの数をアイコンに出す。一覧と移動は popup（options.html）が行う。
// 外へは何も送らない。記録は chrome.storage.session（Chrome を終えると消える。タブも読み込み直しになるので合う）。

import { DEFAULTS, OLD_GROUP_TITLE, overdue, isLoaded } from './core.js';

const ALARM = 'toolong-check';

// 記録の読み書きを 1 つずつ行う（確認の途中で別の出来事が記録を書き換え、上書きで失われないように）
let queue = Promise.resolve();
function serial(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

async function loadState() {
  const s = await chrome.storage.session.get({ loadedAt: {} });
  return { loadedAt: s.loadedAt };
}

async function saveState(state) {
  await chrome.storage.session.set(state);
}

// 記録の無いタブ（入れた直後・Chrome の起動直後にもう開いていたタブ）の読み込み時刻を埋める。
// 「すべてのサイト」の許可があれば、ページの performance.timeOrigin（読み込んだ時刻）を読む。
// 許可が無いか読めないページ（chrome:// など）は、今の時刻を入れる（実際より若く見える）。
async function fillUnknown(tabs, loadedAt) {
  const canRead = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  const now = Date.now();
  await Promise.all(tabs.filter(t => isLoaded(t) && loadedAt[t.id] === undefined).map(async t => {
    let t0 = null;
    if (canRead && /^https?:/.test(t.url || '')) {
      try {
        const [r] = await Promise.race([
          chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => performance.timeOrigin }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
        ]);
        if (typeof r?.result === 'number') t0 = Math.round(r.result);
      } catch { /* 凍結中・読めないページは今の時刻で */ }
    }
    loadedAt[t.id] = t0 ?? now;
  }));
}

async function check() {
  const conf = await settings();
  const state = await loadState();
  const tabs = await chrome.tabs.query({});
  await fillUnknown(tabs, state.loadedAt);

  const live = new Set(tabs.map(t => t.id));
  for (const id of Object.keys(state.loadedAt)) if (!live.has(+id)) delete state.loadedAt[id];
  await saveState(state);

  const count = overdue(tabs, state.loadedAt, Date.now(), conf.hours).length;
  await chrome.action.setBadgeText({ text: count ? String(count) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
}

// 0.1.0 は、時間を過ぎたタブを「TooLong」グループへ移していた。そのグループを片付け、元のグループへ戻す
async function cleanupOldGroups() {
  const s = await chrome.storage.session.get({ origGroup: {} });
  const groups = await chrome.tabGroups.query({ title: OLD_GROUP_TITLE });
  for (const g of groups) {
    for (const tab of await chrome.tabs.query({ groupId: g.id })) {
      const orig = s.origGroup[tab.id];
      try {
        let back = orig ? await chrome.tabGroups.get(orig.id).catch(() => null) : null;
        if (back && back.windowId !== tab.windowId) back = null;
        if (!back && orig?.title) back = (await chrome.tabGroups.query({ windowId: tab.windowId, title: orig.title }))[0];
        if (back) {
          await chrome.tabs.group({ groupId: back.id, tabIds: [tab.id] });
        } else if (orig?.title) {
          const gid = await chrome.tabs.group({ createProperties: { windowId: tab.windowId }, tabIds: [tab.id] });
          await chrome.tabGroups.update(gid, { title: orig.title, color: orig.color });
        } else {
          await chrome.tabs.ungroup(tab.id);
        }
      } catch { /* タブが閉じられた */ }
    }
  }
  await chrome.storage.session.remove('origGroup');
  await chrome.storage.sync.remove(['color', 'restore']);
}

// ── 読み込みの記録 ──

// ページを読み込んだ（同じページの中の移動は数えない）
chrome.webNavigation.onCommitted.addListener(d => d.frameId === 0 && serial(async () => {
  const state = await loadState();
  state.loadedAt[d.tabId] = Math.round(d.timeStamp);
  await saveState(state);
}));

// タブを外すと、タブの id が入れ替わることがある
chrome.tabs.onReplaced.addListener((added, removed) => serial(async () => {
  const state = await loadState();
  if (state.loadedAt[removed] !== undefined) state.loadedAt[added] = state.loadedAt[removed];
  delete state.loadedAt[removed];
  await saveState(state);
}));

chrome.tabs.onRemoved.addListener(id => serial(async () => {
  const state = await loadState();
  delete state.loadedAt[id];
  await saveState(state);
}));

// ── 起動・定期の確認 ──

function schedule() {
  chrome.alarms.create(ALARM, { periodInMinutes: 5 });
}

chrome.runtime.onInstalled.addListener(d => {
  schedule();
  serial(async () => {
    if (d.reason === 'update') await cleanupOldGroups();
    await check();
  });
});
chrome.runtime.onStartup.addListener(() => { schedule(); serial(check); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === ALARM) serial(check); });

// 一覧の画面から
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'check') {
    serial(check).then(() => reply({ ok: true }), e => reply({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type === 'status') {
    serial(async () => {
      await check();
      const state = await loadState();
      return { tabs: await chrome.tabs.query({}), loadedAt: state.loadedAt, windows: (await chrome.windows.getAll()).map(w => w.id) };
    }).then(reply, e => reply({ error: String(e) }));
    return true;
  }
  if (msg?.type === 'forget') {
    // 許可を出した直後など、読み込み時刻を取り直す
    serial(async () => {
      await saveState({ loadedAt: {} });
      await check();
    }).then(() => reply({ ok: true }), e => reply({ ok: false, error: String(e) }));
    return true;
  }
});
