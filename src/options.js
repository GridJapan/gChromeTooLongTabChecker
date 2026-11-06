import { DEFAULTS, overdue, formatAge } from './core.js';

const $ = id => document.getElementById(id);

// その窓を前に出し、タブを選ぶ
export async function focusTab(tab) {
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
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
    const t = Object.assign(document.createElement('span'), { className: 'title', textContent: tab.title || tab.url });
    const w = Object.assign(document.createElement('span'), { className: 'win', textContent: `窓${winNo.get(tab.windowId) ?? '?'}` });
    li.append(a, icon, t, w);
    const go = () => focusTab(tab).then(() => window.close());
    li.onclick = go;
    li.onkeydown = e => { if (e.key === 'Enter') go(); };
    ul.appendChild(li);
  }

  const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  $('perm-note').textContent = granted
    ? ''
    : '入れる前から開いていたタブは、入れた時刻から数えています（実際より短く出ます）。';
  $('perm').hidden = granted;
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
