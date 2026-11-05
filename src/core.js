// 判定だけを行う部分。chrome.* を呼ばないので、node のテストからも読める。

export const GROUP_TITLE = 'TooLong';

export const DEFAULTS = {
  hours: 24,          // 読み込んでからこの時間を過ぎたタブを TooLong へ移す
  color: 'red',       // TooLong グループの色
  restore: true,      // 読み込み直した・外れたタブを、元のグループへ戻す
};

export const HOUR = 3600 * 1000;

// メモリを使っている（読み込まれている）タブか
export function isLoaded(tab) {
  return !tab.discarded && tab.status !== 'unloaded';
}

// 読み込んでからの時間（ミリ秒）。記録が無ければ null
export function ageOf(tab, loadedAt, now) {
  const t = loadedAt[tab.id];
  return typeof t === 'number' ? Math.max(0, now - t) : null;
}

// 何をするかを決める。
//   tabs:        chrome.tabs.query({}) の結果
//   loadedAt:    { tabId: 読み込んだ時刻(ms) }
//   tooLongIds:  TooLong グループの id の集合（窓ごとに 1 つ）
// 返り値:
//   group:   { windowId: [tabId, ...] }  TooLong へ移すタブ
//   release: [tabId, ...]                TooLong から出すタブ（読み込み直した・外れた）
export function plan(tabs, loadedAt, now, hours, tooLongIds) {
  const limit = hours * HOUR;
  const group = {};
  const release = [];
  for (const tab of tabs) {
    const inTooLong = tooLongIds.has(tab.groupId);
    const age = ageOf(tab, loadedAt, now);
    const old = isLoaded(tab) && age !== null && age >= limit;
    if (old && !inTooLong && !tab.pinned) {
      (group[tab.windowId] ||= []).push(tab.id);
    } else if (!old && inTooLong) {
      release.push(tab.id);
    }
  }
  return { group, release };
}

// 3 時間 5 分 → "3時間5分"
export function formatAge(ms) {
  if (ms === null || ms === undefined) return '不明';
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d) return `${d}日${h}時間`;
  if (h) return `${h}時間${mm}分`;
  return `${mm}分`;
}
