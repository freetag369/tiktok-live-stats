// Captures each screen via CDP so the UI can be reviewed without OS-level access.
import { writeFileSync, mkdirSync } from 'node:fs';
import { WebSocket } from 'ws';

const PORT = process.argv[2] ?? '9223';
const OUT = process.argv[3] ?? 'shots';
mkdirSync(OUT, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params) =>
  new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  }
});
await new Promise((r) => ws.on('open', r));

const evaluate = (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });

async function shot(name) {
  await new Promise((r) => setTimeout(r, 900));
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  console.log(`${OUT}/${name}.png`);
}

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

const nav = (label) =>
  evaluate(`[...document.querySelectorAll(".nav button")].find(b=>b.textContent===${JSON.stringify(label)})?.click()`);

await nav('接続');
await shot('1-connect');

await nav('配信履歴');
await new Promise((r) => setTimeout(r, 900));
await evaluate('document.querySelector("table.data tbody tr")?.click()');
await shot('2-sessions');

await nav('分析');
await shot('3-analytics');

await nav('設定');
await shot('4-settings');

// Open a viewer card from the leaderboard.
await nav('分析');
await new Promise((r) => setTimeout(r, 600));
await evaluate('[...document.querySelectorAll("table.data tbody tr")].pop()?.click()');
await shot('5-viewer');
await evaluate('document.querySelector(".modal-bg")?.click()');

await nav('ライブ');
await shot('6-live');

ws.close();
process.exit(0);
