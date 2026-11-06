// 判定だけを行う部分。chrome.* を呼ばないので、node のテストからも読める。

export const DEFAULTS = {
  hours: 24,          // 読み込んでからこの時間を過ぎたタブを一覧に出す
};

// 0.1.0 が作っていたグループの名前。更新したときに片付ける
export const OLD_GROUP_TITLE = 'TooLong';

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

// 決めた時間を過ぎた、読み込まれているタブ。古い順に [{ tab, age }]
export function overdue(tabs, loadedAt, now, hours) {
  const limit = hours * HOUR;
  return tabs
    .filter(isLoaded)
    .map(tab => ({ tab, age: ageOf(tab, loadedAt, now) }))
    .filter(r => r.age !== null && r.age >= limit)
    .sort((a, b) => b.age - a.age);
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
