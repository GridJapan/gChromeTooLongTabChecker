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
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? '✔' : '✖'} ${label}${ok ? '' : `\n    期待 ${JSON.stringify(want)}\n    実際 ${JSON.stringify(got)}`}`);
};
// 別のページ（拡張機能の一覧の画面など）につないで式を評価する
const attach = async url => {
  const t = (await j('/json/list')).find(x => x.url.startsWith(url));
  const s2 = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => s2.onopen = r);
  let k = 0; const pd = new Map();
  s2.onmessage = e => { const m = JSON.parse(e.data); if (pd.has(m.id)) { pd.get(m.id)(m); pd.delete(m.id); } };
  const run = async expr => { const i = ++k; s2.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); const m = await new Promise(r => pd.set(i, r)); return m.result.result?.value; };
  return { run, close: () => s2.close() };
};

// 窓 2 つにタブを 3 つ。p1・p3 は古くし、p2 はあとで読み込み直して新しくする
await ev(`(async () => {
  await chrome.tabs.create({ url: '${B}p1', active: false });
  const w2 = await chrome.windows.create({ url: '${B}p3' });
  await chrome.tabs.create({ url: '${B}p2', active: false });
  await chrome.storage.sync.set({ hours: 0.002 });   // 7.2 秒
  return 1;
})()`);
await sleep(8500);
await ev(`(async () => { const [t] = await chrome.tabs.query({ url: '${B}p2' }); await chrome.tabs.reload(t.id); await new Promise(r => setTimeout(r, 1500)); return 1; })()`);

const EXTURL = `chrome-extension://${MYID}/options.html`;
await ev(`chrome.tabs.create({ url: '${EXTURL}' }).then(() => 1)`);
await sleep(2500);
const page = await attach(EXTURL);
const items = await page.run(`[...document.querySelectorAll('#list li .title')].map(e => e.textContent)`);
expect('時間を過ぎたタブだけが、古い順に一覧に出る（最初の about:blank も古い。読み込み直した p2 は出ない）', items, ['about:blank', 'page1', 'page3']);
expect('アイコンの数', await ev(`chrome.action.getBadgeText({})`), '3');   // p1・p3 と最初の about:blank

// 一覧の page3（別の窓）を押す
await page.run(`[...document.querySelectorAll('#list li')].find(li => li.querySelector('.title').textContent === 'page3').click(), 1`);
await sleep(1500);
const active = await ev(`(async () => {
  const [t] = await chrome.tabs.query({ url: '${B}p3' });
  const w = await chrome.windows.get(t.windowId);
  const [cur] = await chrome.tabs.query({ active: true, windowId: t.windowId });
  return { tabActive: t.active, windowFocused: w.focused, activeTitle: cur.title };
})()`);
expect('押すと、その窓が前に出て、そのタブが選ばれる', active, { tabActive: true, windowFocused: true, activeTitle: 'page3' });

page.close(); ws.close();
done(failed ? 1 : 0);
