// タブを読み込んだ時刻を覚え、決めた時間を過ぎたタブを窓ごとの「TooLong」グループへ移す。
// 外へは何も送らない。記録は chrome.storage.session（Chrome を終えると消える。タブも読み込み直しになるので合う）。

import { GROUP_TITLE, DEFAULTS, plan, isLoaded } from './core.js';

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
  const s = await chrome.storage.session.get({ loadedAt: {}, origGroup: {} });
  return { loadedAt: s.loadedAt, origGroup: s.origGroup };
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

async function tooLongGroups() {
  const gs = await chrome.tabGroups.query({ title: GROUP_TITLE });
  return new Map(gs.map(g => [g.windowId, g.id]));
}

async function check() {
  const conf = await settings();
  const state = await loadState();
  const tabs = await chrome.tabs.query({});
  await fillUnknown(tabs, state.loadedAt);

  const live = new Set(tabs.map(t => t.id));
  for (const id of Object.keys(state.loadedAt)) if (!live.has(+id)) delete state.loadedAt[id];

  const byWindow = await tooLongGroups();
  const { group, release } = plan(tabs, state.loadedAt, Date.now(), conf.hours, new Set(byWindow.values()));
  const tabById = new Map(tabs.map(t => [t.id, t]));

  for (const [windowId, ids] of Object.entries(group)) {
    for (const id of ids) {
      const g = tabById.get(id).groupId;
      if (g === -1) continue;
      // グループが空になると Chrome が消すので、名前と色も覚えておく
      const info = await chrome.tabGroups.get(g).catch(() => null);
      state.origGroup[id] = { id: g, title: info?.title ?? '', color: info?.color ?? 'grey' };
    }
    try {
      const gid = byWindow.get(+windowId);
      if (gid !== undefined) {
        await chrome.tabs.group({ groupId: gid, tabIds: ids });
      } else {
        const newId = await chrome.tabs.group({ createProperties: { windowId: +windowId }, tabIds: ids });
        await chrome.tabGroups.update(newId, { title: GROUP_TITLE, color: conf.color });
      }
    } catch (e) {
      console.warn('TooLong: グループに入れられませんでした', windowId, ids, e);
    }
  }

  for (const id of release) await releaseTab(id, state, conf);
  await saveState(state);
  await updateBadge(tabs, state.loadedAt, conf.hours);
}

// TooLong から出す。元のグループへ戻す（消えていれば、同じ名前のグループを探すか作り直す）
async function releaseTab(id, state, conf) {
  const orig = state.origGroup[id];
  delete state.origGroup[id];
  try {
    if (conf.restore && orig) {
      const tab = await chrome.tabs.get(id);
      let g = await chrome.tabGroups.get(orig.id).catch(() => null);
      if (!g || g.windowId !== tab.windowId) {
        g = orig.title ? (await chrome.tabGroups.query({ windowId: tab.windowId, title: orig.title }))[0] : null;
      }
      if (g) {
        await chrome.tabs.group({ groupId: g.id, tabIds: [id] });
      } else {
        const gid = await chrome.tabs.group({ createProperties: { windowId: tab.windowId }, tabIds: [id] });
        await chrome.tabGroups.update(gid, { title: orig.title, color: orig.color });
      }
      return;
    }
    await chrome.tabs.ungroup(id);
  } catch { /* タブが閉じられた */ }
}

async function updateBadge(tabs, loadedAt, hours) {
  const n = plan(tabs, loadedAt, Date.now(), hours, new Set()).group;
  const count = Object.values(n).reduce((a, ids) => a + ids.length, 0);
  await chrome.action.setBadgeText({ text: count ? String(count) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
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
  if (state.origGroup[removed] !== undefined) state.origGroup[added] = state.origGroup[removed];
  delete state.loadedAt[removed];
  delete state.origGroup[removed];
  await saveState(state);
}));

chrome.tabs.onRemoved.addListener(id => serial(async () => {
  const state = await loadState();
  delete state.loadedAt[id];
  delete state.origGroup[id];
  await saveState(state);
}));

// ── 起動・定期の確認 ──

function schedule() {
  chrome.alarms.create(ALARM, { periodInMinutes: 5 });
}

chrome.runtime.onInstalled.addListener(() => { schedule(); serial(check); });
chrome.runtime.onStartup.addListener(() => { schedule(); serial(check); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === ALARM) serial(check); });

// 設定画面から
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'check') {
    serial(check).then(() => reply({ ok: true }), e => reply({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type === 'status') {
    (async () => {
      const state = await loadState();
      const tabs = await chrome.tabs.query({});
      reply({ tabs, loadedAt: state.loadedAt, groups: [...(await tooLongGroups()).values()] });
    })();
    return true;
  }
  if (msg?.type === 'forget') {
    // 許可を出した直後など、読み込み時刻を取り直す（元のグループの記録は残す）
    serial(async () => {
      const state = await loadState();
      await saveState({ ...state, loadedAt: {} });
      await check();
    }).then(() => reply({ ok: true }), e => reply({ ok: false, error: String(e) }));
    return true;
  }
});
