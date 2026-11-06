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

// メモリの記録 { t0, v0, t, v, min, max }（v はバイト）に、測った値を 1 つ足す
export function addSample(rec, t, v) {
  if (!rec) return { t0: t, v0: v, t, v, min: v, max: v };
  return { ...rec, t, v, min: Math.min(rec.min, v), max: Math.max(rec.max, v) };
}

// 最初に測ってから今までの、1 時間あたりの増え方（バイト）。測った間が 10 分に満たなければ null
export function perHour(rec) {
  const dt = rec.t - rec.t0;
  return dt >= 10 * 60000 ? (rec.v - rec.v0) / dt * HOUR : null;
}

export function formatMB(bytes) {
  return bytes === null || bytes === undefined ? '—' : `${Math.round(bytes / 1048576)}MB`;
}
