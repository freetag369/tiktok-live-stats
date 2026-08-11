// Verifies what the renderer ACTUALLY rendered, via the Chrome DevTools Protocol.
// More reliable than a screenshot for asserting text content and console errors.
import { WebSocket } from 'ws';

const PORT = process.argv[2] ?? '9222';

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.error('page target が見つかりません:', targets.map((t) => t.type).join(', '));
  process.exit(1);
}
console.log('URL:', page.url);
console.log('title:', page.title);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params) =>
  new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

const consoleErrors = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(`EXCEPTION: ${m.params.exceptionDetails.text} ${m.params.exceptionDetails.exception?.description ?? ''}`);
  }
});

await new Promise((r) => ws.on('open', r));
await send('Runtime.enable');
await new Promise((r) => setTimeout(r, 2500));

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return `<error: ${r.exceptionDetails.text}>`;
  return r.result?.value;
}

console.log('\n--- window.api ---');
console.log(await evaluate('Object.keys(window.api ?? {}).join(", ")'));

console.log('\n--- 表示テキスト ---');
console.log(await evaluate('document.body.innerText'));

console.log('\n--- ナビゲーション ---');
console.log(await evaluate('[...document.querySelectorAll(".nav button")].map(b=>b.textContent).join(" | ")'));

console.log('\n--- RPC 疎通 (cfg.get) ---');
console.log(await evaluate('window.api.rpc("cfg.get", undefined).then(s=>JSON.stringify({db:s.dbPath,key:s.eulerApiKey?"set":"unset",jpy:s.diamondToJpy})).catch(e=>"ERR: "+e.message)'));

console.log('\n--- RPC 疎通 (q.diagnostics) ---');
console.log(
  await evaluate(
    'window.api.rpc("q.diagnostics", undefined).then(d=>JSON.stringify({fts5:d.capabilities.fts5,journal:d.capabilities.journalMode,schema:d.capabilities.schemaVersion,ver:d.appVersion,sha:d.gitSha.slice(0,8),rows:d.rowCounts})).catch(e=>"ERR: "+e.message)'
  )
);

console.log('\n--- 画面遷移テスト ---');
for (const label of ['分析', '設定', '配信履歴']) {
  await evaluate(`[...document.querySelectorAll(".nav button")].find(b=>b.textContent==="${label}")?.click()`);
  await new Promise((r) => setTimeout(r, 700));
  const heading = await evaluate('document.querySelector(".main h2, .main .pane header strong")?.textContent ?? "(なし)"');
  const cards = await evaluate('document.querySelectorAll(".card").length');
  console.log(`  ${label} -> 見出し「${heading}」 / カード ${cards}枚`);
}

console.log('\n--- コンソールエラー ---');
console.log(consoleErrors.length === 0 ? '  なし' : consoleErrors.map((e) => '  ' + e).join('\n'));

ws.close();
process.exit(consoleErrors.length === 0 ? 0 : 1);
