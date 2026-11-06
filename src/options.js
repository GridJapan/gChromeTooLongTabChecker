import { DEFAULTS, overdue, formatAge, formatMB, perHour } from './core.js';

const $ = id => document.getElementById(id);

// その窓を前に出し、タブを選ぶ
export async function focusTab(tab) {
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
}

// 「最初 120MB → 今 340MB（最低 110MB／最高 360MB）・1 時間あたり +22MB」
function memLine(rec, canRead, tab) {
  const div = Object.assign(document.createElement('div'), { className: 'mem' });
  if (!/^https?:/.test(tab.url || '')) div.textContent = 'メモリ: このページは測れません';
  else if (!canRead) div.textContent = 'メモリ: 測るには、下のボタンで許可を出してください';
  else if (!rec) div.textContent = 'メモリ: まだ測っていません（5 分ごとに測ります）';
  else {
    const ph = perHour(rec);
    div.append(`メモリ 最初 ${formatMB(rec.v0)} → 今 ${formatMB(rec.v)}（最低 ${formatMB(rec.min)}／最高 ${formatMB(rec.max)}）・1 時間あたり `);
    const span = document.createElement('span');
    if (ph === null) span.textContent = '測定中';
    else {
      span.textContent = `${ph >= 0 ? '+' : '−'}${formatMB(Math.abs(ph))}`;
      span.className = ph > 0 ? 'up' : 'down';
    }
    div.append(span);
    div.title = `最初に測った時刻 ${new Date(rec.t0).toLocaleString()}／最後に測った時刻 ${new Date(rec.t).toLocaleString()}（ページの JavaScript のメモリ）`;
  }
  return div;
}

async function render() {
  const s = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  $('hours').value = s.hours;
  const st = await chrome.runtime.sendMessage({ type: 'status' });
  const rows = overdue(st.tabs, st.loadedAt, Date.now(), s.hours);
  const winNo = new Map(st.windows.map((id, i) => [id, i + 1]));

  $('summary').textContent = rows.length
    ? `${s.hours} 時間を過ぎたタブ ${rows.length} 個（古い順）。押すとそのタブへ移ります`
    : '';
  const ul = $('list');
  ul.textContent = '';
  if (!rows.length) {
    const li = document.createElement('div');
    li.className = 'empty';
    li.textContent = `${s.hours} 時間を過ぎたタブはありません`;
    ul.appendChild(li);
  }
  for (const { tab, age } of rows) {
    const li = document.createElement('li');
    li.tabIndex = 0;
    li.title = tab.url || '';
    const icon = document.createElement('img');
    // サイトへ取りに行かず、Chrome が手元に持っているアイコンを使う
    icon.src = `/_favicon/?pageUrl=${encodeURIComponent(tab.url || '')}&size=16`;
    icon.alt = '';
    const a = Object.assign(document.createElement('span'), { className: 'age', textContent: formatAge(age) });
    const main = Object.assign(document.createElement('div'), { className: 'main' });
    main.append(
      Object.assign(document.createElement('div'), { className: 'title', textContent: tab.title || tab.url }),
      memLine(st.mem[tab.id], st.canRead, tab),
    );
    const w = Object.assign(document.createElement('span'), { className: 'win', textContent: `窓${winNo.get(tab.windowId) ?? '?'}` });
    li.append(a, icon, main, w);
    const go = () => focusTab(tab).then(() => window.close());
    li.onclick = go;
    li.onkeydown = e => { if (e.key === 'Enter') go(); };
    ul.appendChild(li);
  }

  $('perm-note').textContent = st.canRead
    ? 'メモリは、ページの JavaScript のメモリを 5 分ごとに測った値です（タブ全体のメモリより小さく出ます）。'
    : '許可が無いので、メモリは測っていません。入れる前から開いていたタブは、入れた時刻から数えています（実際より短く出ます）。';
  $('perm').hidden = st.canRead;
}

$('save').onclick = async () => {
  const hours = Math.max(0.1, Number($('hours').value) || DEFAULTS.hours);
  await chrome.storage.sync.set({ hours });
  await chrome.runtime.sendMessage({ type: 'check' });
  render();
};

$('perm').onclick = async () => {
  if (await chrome.permissions.request({ origins: ['<all_urls>'] })) {
    await chrome.runtime.sendMessage({ type: 'forget' });
  }
  render();
};

render();
