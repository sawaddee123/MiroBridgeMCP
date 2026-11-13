#!/usr/bin/env node
// MCP (stdio) <-> WebSocket <-> Miro Web SDK app running inside an open board.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const PORT = Number(process.env.MIRO_BRIDGE_PORT || 7788);
const ORIGIN = `http://localhost:${PORT}`;
const TIMEOUT_MS = 30_000;
const log = (...a) => console.error('[MiroBridgeMCP]', ...a); // stdout is reserved for MCP

// --- HTTP: serves the Miro app page (App URL = http://localhost:PORT/) ---
const http = createServer(async (req, res) => {
  log(`http ${req.method} ${req.url}`); // proves Miro loaded the app iframe
  const path = new URL(req.url, ORIGIN).pathname; // Miro appends ?_miro=...&_sdk=...
  if (path !== '/' && path !== '/index.html') return res.writeHead(404).end();
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    // only Miro may embed the app; otherwise any website could iframe it, pose as a board and feed Claude fake data
    'Content-Security-Policy': 'frame-ancestors https://miro.com https://*.miro.com',
  });
  res.end(await readFile(new URL('./app/index.html', import.meta.url)));
});

// --- WebSocket: the board side. Only the app page we serve may connect. ---
let board = null;
const pending = new Map();
const wss = new WebSocketServer({
  server: http,
  verifyClient: ({ origin }) => {
    const ok = origin === ORIGIN || origin === `http://127.0.0.1:${PORT}`;
    if (!ok) log(`rejected websocket from origin ${origin}`);
    return ok;
  },
});
const boards = []; // all open board tabs; newest one gets commands (closing others would make them reconnect-fight)
wss.on('connection', (ws) => {
  boards.push(ws);
  board = ws;
  log(`board connected (${boards.length} open)`);
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
  });
  ws.on('close', () => {
    boards.splice(boards.indexOf(ws), 1);
    if (board === ws) board = boards.at(-1) ?? null;
    log(`board disconnected (${boards.length} open)`);
  });
});

let portError = null;
http.on('error', (e) => { portError = e; log(`cannot listen on ${PORT}:`, e.message); });
http.listen(PORT, '127.0.0.1', () => log(`app + bridge on ${ORIGIN}`));

function call(op, params = {}) {
  if (portError) return Promise.reject(new Error(`Bridge port ${PORT} unavailable (${portError.code}). Usually another Claude session already runs miro-bridge: close it, or use that session. Only one session can drive the board at a time.`));
  if (!board) return Promise.reject(new Error(`No Miro board connected. Ask the user to check: 1) the MiroBridgeMCP app is installed in the board's team (install link from whoever shared miro-bridge), 2) a board of that team is open in Chrome/Edge or the Miro desktop app, 3) reload the board tab once. Brave: allow localhost access for miro.com. Diagnose with: miro-bridge-mcp check (re-run miro-bridge-mcp setup to repair)`));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Board did not answer "${op}" within ${TIMEOUT_MS / 1000}s`)); }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    board.send(JSON.stringify({ id, op, params }));
  });
}

// --- MCP tools ---
const mcp = new McpServer({ name: 'MiroBridgeMCP', version: '1.0.0' });
const tool = (name, description, inputSchema, run = (args) => call(name, args)) =>
  mcp.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      const result = await run(args);
      return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e.message }] };
    }
  });

// Raw SDK items are ~3x bigger than needed (timestamps, authors, origin, full style...). Measured: 238 items = 58k tokens raw.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ', '#39': "'" };
const plainText = (s) => typeof s === 'string'
  ? s.replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&(amp|lt|gt|quot|nbsp|#39);/g, (_, e) => ENTITIES[e]).trim()
  : undefined;
function compact(i) {
  const o = { id: i.id, type: i.type };
  if (i.type === 'shape' || i.type === 'connector') o.shape = i.shape;
  for (const k of ['content', 'title', 'description']) { const t = plainText(i[k]); if (t) o[k] = t; }
  for (const k of ['x', 'y', 'width', 'height']) if (typeof i[k] === 'number') o[k] = Math.round(i[k]);
  if (i.parentId) o.parentId = i.parentId;
  if (i.style?.fillColor && i.style.fillColor !== 'transparent') o.fill = i.style.fillColor;
  if (i.start?.item) o.from = i.start.item;
  if (i.end?.item) o.to = i.end.item;
  if (i.captions?.length) o.captions = i.captions.map((c) => plainText(c.content));
  if (i.url && !i.url.startsWith('data:')) o.url = i.url;
  return o;
}
const compactMany = (op) => async (args) => (await call(op, args)).map(compact);

// Local image file -> data URL (Miro's servers can't fetch localhost, but the SDK accepts data URLs).
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
async function withFile(item) {
  if (item.type !== 'image' || !item.props.path) return item;
  const { path, ...props } = item.props;
  const mime = MIME[extname(path).slice(1).toLowerCase()];
  if (!mime) throw new Error(`Not an image file (png/jpg/gif/webp/svg): ${path}`);
  return { ...item, props: { ...props, url: `data:${mime};base64,${(await readFile(path)).toString('base64')}` } };
}

const ITEM_TYPES = ['sticky_note', 'shape', 'text', 'card', 'app_card', 'frame', 'connector', 'image', 'embed', 'preview', 'group'];
const ids = z.array(z.string()).min(1);
const ITEM_FIELDS = 'Items come back compact: {id, type, content/title as plain text, x, y, width, height, parentId, fill (= style.fillColor), from/to (connector ends)}. ' +
  'x/y of an item with parentId are relative to the frame top-left.';

async function focusItems() {
  const ids = new Set(await call('get_focus_ids'));
  if (!ids.size) return [];
  return (await call('get_items')).filter((i) => ids.has(i.id) || ids.has(i.parentId));
}
const FOCUS_RULE = 'Focus is the part of the board the user is working on now: start from it and prefer it, ' +
  'but it is not a boundary; read or reference other items when the task needs them (old ideas, related frames).';

tool('get_board_info',
  'Cheap overview: board id, item counts by type, frames {id, title, children}, and whether the user set a focus. Call this first instead of reading the whole board, then get_focus or get_items with parentId.',
  {}, async () => {
    const [info, items] = await Promise.all([call('get_board_info'), call('get_items')]);
    const counts = {};
    for (const i of items) counts[i.type] = (counts[i.type] || 0) + 1;
    const frames = items.filter((i) => i.type === 'frame').map((f) => ({ id: f.id, title: plainText(f.title), children: f.childrenIds?.length ?? 0 }));
    const focus = (await call('get_focus_ids')).length;
    return { id: info.id, counts, frames, focus: focus ? `${focus} item(s) marked; call get_focus first` : 'none' };
  });
tool('get_items',
  `List board items, filtered by type, ids and/or parentId (a frame id). ${ITEM_FIELDS} Pass full:true only if you need raw Web SDK fields.`,
  { type: z.array(z.enum(ITEM_TYPES)).optional(), ids: ids.optional(), parentId: z.string().optional(), full: z.boolean().optional() },
  async ({ parentId, full, ...query }) => {
    let items = await call('get_items', query);
    if (parentId) items = items.filter((i) => i.parentId === parentId);
    return full ? items : items.map(compact);
  });
tool('get_focus',
  `Items the user marked as focus (select on the board + click the MiroBridgeMCP icon), including everything inside focused frames. ${FOCUS_RULE} Compact items.`,
  {}, async () => (await focusItems()).map(compact));
tool('set_focus', `Set the focus to these ids (frames include their children), or [] to clear. ${FOCUS_RULE}`,
  { ids: z.array(z.string()) }, (args) => call('set_focus', args));
tool('get_selection', 'Items the user currently has selected on the board (compact).', {}, compactMany('get_selection'));
tool('create_items',
  'Create one or many items in one call. Each entry is {type, props}; props are Web SDK create props, e.g. ' +
  'sticky_note {content:"<p>hi</p>", x, y, style:{fillColor:"light_yellow"}}; shape {shape:"rectangle", content, x, y, width, height}; ' +
  'text {content, x, y}; frame {title, x, y, width, height}; connector {start:{item:id, snapTo:"right"}, end:{item:id, snapTo:"left"}, shape:"curved"|"straight"|"elbowed", style:{strokeColor:"#1a1a1a", strokeWidth:2, strokeStyle:"dashed", startStrokeCap:"none", endStrokeCap:"arrow"}, captions:[{content}]} (snapTo: auto|top|right|bottom|left); ' +
  'card {title, description, x, y}; image {url, x, y} or {path:"C:/local/file.png", x, y, width}; embed {url, x, y}. Add parentId to place the item inside a frame (x/y here are still board coordinates). Returns created items (compact).',
  { items: z.array(z.object({ type: z.enum(['sticky_note', 'shape', 'text', 'card', 'app_card', 'frame', 'connector', 'image', 'embed']), props: z.record(z.any()) })).min(1) },
  async ({ items }) => (await call('create_items', { items: await Promise.all(items.map(withFile)) })).map(compact));
tool('update_items',
  'Update items: each entry is {id, props}; props are merged into the item (nested style is merged too) then synced. Returns updated items (compact).',
  { items: z.array(z.object({ id: z.string(), props: z.record(z.any()) })).min(1) }, compactMany('update_items'));
tool('arrange_items',
  'Auto-layout items into a tidy grid/row/column (uniform cells = largest item, gap between). Give ids (kept in that order) or parentId (all items in that frame, current reading order). ' +
  'Connectors are skipped; they follow their items. Starts at the current top-left of the items. Returns {moved, columns}.',
  { ids: ids.optional(), parentId: z.string().optional(), layout: z.enum(['grid', 'row', 'column']).default('grid'), columns: z.number().int().min(1).optional(), gap: z.number().min(0).default(40) },
  async ({ ids: list, parentId, layout, columns, gap }) => {
    if (!list && !parentId) throw new Error('Give ids or parentId');
    let items = (await call('get_items', list ? { ids: list } : {})).filter((i) => i.type !== 'connector' && typeof i.x === 'number');
    if (parentId) items = items.filter((i) => i.parentId === parentId).sort((a, b) => (a.y - a.height / 2) - (b.y - b.height / 2) || a.x - b.x);
    else items.sort((a, b) => list.indexOf(a.id) - list.indexOf(b.id));
    if (!items.length) return { moved: 0, columns: 0 };
    if (new Set(items.map((i) => i.parentId ?? '')).size > 1) throw new Error('Items are in different frames; arrange each frame separately');
    const cols = layout === 'row' ? items.length : layout === 'column' ? 1 : columns ?? Math.ceil(Math.sqrt(items.length));
    const cw = Math.max(...items.map((i) => i.width)), ch = Math.max(...items.map((i) => i.height));
    const left = Math.min(...items.map((i) => i.x - i.width / 2)), top = Math.min(...items.map((i) => i.y - i.height / 2));
    // shortcut: no frame auto-resize, a big grid can spill past the frame edge; pass columns or resize the frame with update_items
    await call('update_items', { items: items.map((i, n) => ({ id: i.id, props: {
      x: Math.round(left + (n % cols) * (cw + gap) + cw / 2),
      y: Math.round(top + Math.floor(n / cols) * (ch + gap) + ch / 2),
    } })) });
    return { moved: items.length, columns: cols };
  });
tool('delete_items', 'Delete items by id. Deleting an item also deletes connectors attached to it; ids already gone are counted in alreadyGone.', { ids });
tool('zoom_to', 'Move the viewport so the given items are visible.', { ids });

mcp.registerTool('capture', {
  description: 'Screenshot of the Miro window so you can see the result. Optionally zoom to ids first. Windows only; the board window must not be minimized (it may be behind others). ~1.5k tokens per image, so capture once after a batch of changes, not after every call.',
  inputSchema: { ids: ids.optional(), maxWidth: z.number().int().min(400).max(2400).default(1400) },
}, async ({ ids: zoomIds, maxWidth }) => {
  try {
    if (process.platform !== 'win32') throw new Error('capture is Windows-only for now; ask the user to look at the board instead.');
    if (zoomIds) { await call('zoom_to', { ids: zoomIds }); await new Promise((r) => setTimeout(r, 1500)); } // let the zoom animation finish
    const out = join(tmpdir(), `miro-capture-${process.pid}.png`);
    const info = await new Promise((resolve, reject) => execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./capture.ps1', import.meta.url)), '-Out', out, '-MaxWidth', String(maxWidth)],
      (e, stdout, stderr) => (e ? reject(new Error((stderr || e.message).split('\n')[0].trim())) : resolve(stdout.trim()))));
    return { content: [{ type: 'image', data: (await readFile(out)).toString('base64'), mimeType: 'image/png' }, { type: 'text', text: info }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e.message }] };
  }
});

const INSTALL_URL = process.env.MIRO_BRIDGE_INSTALL_URL ||
  'https://miro.com/app-install/?response_type=code&client_id=3458764690361854455&redirect_uri=%2Fapp-install%2Fconfirm%2F';
const command = process.argv[2];
if (command === 'setup') await setup();
else if (command === 'check' || process.argv.includes('--check')) await check();
else await mcp.connect(new StdioServerTransport());

// `miro-bridge-mcp check`: setup diagnosis for people installing it (prints to stdout; not an MCP session)
// `miro-bridge-mcp setup`: register with Claude Code, open the Miro app install page, then wait for a board. Safe to re-run (repairs).
async function setup() {
  const dry = Boolean(process.env.MIRO_BRIDGE_DRY_RUN);
  const self = fileURLToPath(import.meta.url).replaceAll('\\', '/');
  console.log('MiroBridgeMCP setup');
  if (self.includes('/_npx/')) {
    console.log('FAIL this copy lives in the npx cache, which gets cleaned up. Install it once, then run setup:\n' +
      '     npm install -g github:sawaddee123/MiroBridgeMCP\n     miro-bridge-mcp setup');
    process.exit(1);
  }
  // node + absolute path: starts fast, needs no network, and avoids the Windows "cmd /c npx" quirk
  const add = `claude mcp add MiroBridgeMCP -s user -- node "${self}"`;
  if (dry) console.log(`DRY  ${add}`);
  else {
    try { execSync('claude mcp remove MiroBridgeMCP -s user', { stdio: 'ignore' }); } catch {} // re-run = repair
    try { execSync(add, { stdio: 'ignore' }); console.log('OK   registered with Claude Code as "MiroBridgeMCP" (restart Claude Code to load it)'); }
    catch { console.log(`FAIL could not run the claude CLI. Register it yourself:\n     ${add}`); }
  }
  console.log(`...  install the Miro app into the team that owns your boards (opening it in your browser):\n     ${INSTALL_URL}`);
  if (dry) process.exit(0);
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', INSTALL_URL]] // no cmd.exe: the URL has "&"
    : [process.platform === 'darwin' ? 'open' : 'xdg-open', [INSTALL_URL]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  await check(300);
}

async function check(defaultWait = 90) {
  const say = (ok, msg) => console.log(`${ok ? 'OK  ' : 'FAIL'} ${msg}`);
  say(Number(process.versions.node.split('.')[0]) >= 20, `Node ${process.version} (need 20+)`);
  await new Promise((r) => setTimeout(r, 300));
  if (portError) { say(false, `port ${PORT}: ${portError.code}. Another MiroBridgeMCP (Claude session) is probably running; close it and retry.`); process.exit(1); }
  say(true, `bridge listening on ${ORIGIN}`);
  const waitS = Number(process.env.MIRO_BRIDGE_CHECK_WAIT || defaultWait);
  console.log(`...  open or reload a Miro board where the MiroBridgeMCP app is installed (waiting ${waitS}s)`);
  for (const end = Date.now() + waitS * 1000; !board && Date.now() < end;) await new Promise((r) => setTimeout(r, 300));
  if (!board) {
    say(false, 'no board connected. Check: app installed in the board team? board tab reloaded? Brave: allow localhost access for miro.com. Safari is not supported.');
    process.exit(1);
  }
  try {
    const [info, items] = await Promise.all([call('get_board_info'), call('get_items')]);
    say(true, `board connected: ${info.id} (${items.length} items). Ready: (re)start Claude Code and ask it about the board.`);
    process.exit(0);
  } catch (e) { say(false, `board connected but not answering: ${e.message}`); process.exit(1); }
}
