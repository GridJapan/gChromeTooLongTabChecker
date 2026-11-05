// 本物の Chromium（Chrome for Testing）に拡張機能を読み込ませて確かめる。
// 使い捨てのプロファイルを使い、画面は出さない（headless）。ふだんの Chrome には触れない。
//   CFT=<Chrome for Testing の実行ファイル> node tests/e2e.mjs
// 既定は Playwright が入れる場所（npx playwright install chromium）。
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const PW = join(process.env.HOME, 'Library/Caches/ms-playwright');
const CFT = process.env.CFT || join(PW, readdirSync(PW).filter(d => /^chromium-\d+$/.test(d)).sort().pop(),
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const EXT = resolve(import.meta.dirname, '../src');
const site = createServer((req, res) => { const n = req.url.match(/p(\d)/)?.[1] ?? '0'; res.end(`<title>page${n}</title>page${n}`); }).listen(8766, '127.0.0.1');
import { createHash } from 'node:crypto';
const MYID = [...createHash('sha256').update(EXT).digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
const prof = mkdtempSync(join(tmpdir(), 'toolong-e2e-'));
const done = code => { ch.kill(); site.close(); setTimeout(() => { rmSync(prof, { recursive: true, force: true }); process.exit(code); }, 500); };
const port = 9333;
const ch = spawn(CFT, [`--user-data-dir=${prof}`, `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`,
  `--remote-debugging-port=${port}`, '--headless=new', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const j = async p => (await fetch(`http://127.0.0.1:${port}${p}`)).json();
let targets;
for (let i = 0; i < 50; i++) { try { targets = await j('/json/list'); if (targets.some(t => t.url === `chrome-extension://${MYID}/background.js`)) break; } catch {} await sleep(300); }
const sw = targets.find(t => t.type === 'service_worker' && t.url === `chrome-extension://${MYID}/background.js`);
if (!sw) { console.log('拡張機能が読み込まれない', targets.map(t => t.type + ' ' + t.url)); done(1); }
process.on('uncaughtException', e => { console.log('失敗', e.message.slice(0, 400)); done(1); });
const ws = new WebSocket(sw.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let n = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const ev = async expr => { const i = ++n; ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); const m = await new Promise(r => pend.set(i, r)); if (m.result.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails)); return m.result.result.value; };
const B = 'http://127.0.0.1:8766/';
let failed = 0;
const expect = (label, got, want) => {
  const norm = v => JSON.stringify(v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort()) : v);
  const ok = norm(got) === norm(want);
  if (!ok) failed++;
  console.log(`${ok ? '✔' : '✖'} ${label}${ok ? '' : `\n    期待 ${JSON.stringify(want)}\n    実際 ${JSON.stringify(got)}`}`);
};
// アラームを今すぐ鳴らして、定期の確認を 1 回動かす
const check = () => ev(`(async () => { chrome.alarms.create('toolong-check', { when: Date.now() + 10 }); await new Promise(r => setTimeout(r, 2500)); return 1; })()`);
const state = () => ev(`(async () => {
  const out = {};
  for (const t of await chrome.tabs.query({ url: '${B}*' })) {
    out[t.title] = t.groupId === -1 ? '-' : await chrome.tabGroups.get(t.groupId).then(g => g.title + '/' + g.color);
  }
  return out;
})()`);

await ev(`(async () => {
  await chrome.tabs.create({ url: '${B}p1', active: false });
  await chrome.tabs.create({ url: '${B}p2', active: false });
  const t3 = await chrome.tabs.create({ url: '${B}p3', active: false });
  const g = await chrome.tabs.group({ tabIds: [t3.id] });
  await chrome.tabGroups.update(g, { title: '仕事', color: 'blue' });
  await chrome.storage.sync.set({ hours: 0.002 });   // 7.2 秒
  return 1;
})()`);
await sleep(9000);
await check();
expect('時間を過ぎた 3 タブが TooLong へ移る', await state(), { page1: 'TooLong/red', page2: 'TooLong/red', page3: 'TooLong/red' });

await ev(`(async () => { const [t] = await chrome.tabs.query({ url: '${B}p3' }); await chrome.tabs.reload(t.id); await new Promise(r => setTimeout(r, 1500)); return 1; })()`);
await check();
expect('読み込み直したタブは、消えた「仕事」グループを作り直して戻る', await state(), { page1: 'TooLong/red', page2: 'TooLong/red', page3: '仕事/blue' });

await ev(`(async () => { const [t] = await chrome.tabs.query({ url: '${B}p1' }); await chrome.tabs.discard(t.id); return 1; })()`);
await check();
expect('外したタブは TooLong から出る', await state(), { page1: '-', page2: 'TooLong/red', page3: '仕事/blue' });

await ev(`chrome.tabs.create({ url: chrome.runtime.getURL('options.html') }).then(() => 1)`);
await sleep(2000);
const op = (await j('/json/list')).find(t => t.url.endsWith('/options.html'));
const w2 = new WebSocket(op.webSocketDebuggerUrl); await new Promise(r => w2.onopen = r);
w2.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'document.getElementById("summary").textContent', returnByValue: true } }));
const summary = await new Promise(r => w2.onmessage = e => r(JSON.parse(e.data).result.result.value));
expect('設定画面に一覧が出る', /読み込まれているタブ \d+ 個/.test(summary), true);
w2.close(); ws.close();
done(failed ? 1 : 0);
