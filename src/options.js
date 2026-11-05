import { DEFAULTS, HOUR, ageOf, isLoaded, formatAge } from './core.js';

const $ = id => document.getElementById(id);

async function loadSettings() {
  const s = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  $('hours').value = s.hours;
  $('color').value = s.color;
  $('restore').checked = s.restore;
  return s;
}

async function render() {
  const s = await loadSettings();
  const st = await chrome.runtime.sendMessage({ type: 'status' });
  const now = Date.now();
  const groups = new Set(st.groups);
  const rows = st.tabs
    .filter(isLoaded)
    .map(t => ({ t, age: ageOf(t, st.loadedAt, now) }))
    .sort((a, b) => (b.age ?? -1) - (a.age ?? -1));
  const over = rows.filter(r => r.age !== null && r.age >= s.hours * HOUR).length;
  $('summary').textContent =
    `読み込まれているタブ ${rows.length} 個のうち、${s.hours} 時間を過ぎたもの ${over} 個（外れたタブは数えません）`;
  const tb = $('list');
  tb.textContent = '';
  for (const { t, age } of rows) {
    const tr = document.createElement('tr');
    if (age !== null && age >= s.hours * HOUR) tr.className = 'over';
    const state = groups.has(t.groupId) ? 'TooLong' : t.pinned ? 'ピン留め（移しません）' : '';
    for (const [text, cls] of [[formatAge(age)], [t.title || t.url, 'title'], [state]]) {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      tr.appendChild(td);
    }
    tb.appendChild(tr);
  }
  const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  $('perm-note').textContent = granted
    ? '許可済み: 入れる前から開いていたタブも、ページを読み込んだ時刻を読みます（読むのは時刻だけで、外へは送りません）。'
    : '許可なし: 入れる前から開いていたタブは、入れた時刻から数えます（実際より短く出ます）。';
  $('perm').hidden = granted;
}

$('save').onclick = async () => {
  const hours = Math.max(0.1, Number($('hours').value) || DEFAULTS.hours);
  await chrome.storage.sync.set({ hours, color: $('color').value, restore: $('restore').checked });
  $('msg').textContent = '確かめています…';
  const r = await chrome.runtime.sendMessage({ type: 'check' });
  $('msg').textContent = r.ok ? '保存しました' : `失敗: ${r.error}`;
  render();
};

$('perm').onclick = async () => {
  if (await chrome.permissions.request({ origins: ['<all_urls>'] })) {
    await chrome.runtime.sendMessage({ type: 'forget' });
  }
  render();
};

render();
