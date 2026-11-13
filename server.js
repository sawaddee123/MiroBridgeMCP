#!/usr/bin/env node
// MCP (stdio) <-> WebSocket <-> Miro Web SDK app running inside an open board.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { installAutostart, removeAutostart, autostartInstalled } from './service.js';
import { SERVER_ICON, TOOL_ICONS } from './icons.js';

const PORT = Number(process.env.MIRO_BRIDGE_PORT || 7788);
const ORIGIN = `http://localhost:${PORT}`;
const TIMEOUT_MS = 30_000;
const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const command = process.argv[2];
// serve = background service that keeps the bridge up so boards can load the app any time (no F5 dance)
const MODE = command === 'serve' ? 'serve' : 'mcp';
const LOG_FILE = join(tmpdir(), 'mirobridgemcp.log');
if (MODE === 'serve') writeFileSync(LOG_FILE, '');
const log = (...a) => (MODE === 'serve'
  ? appendFileSync(LOG_FILE, `${new Date().toISOString()} ${a.join(' ')}\n`)
  : console.error('[MiroBridgeMCP]', ...a)); // stdout is reserved for MCP

// --- HTTP: serves the Miro app page (App URL = http://localhost:PORT/) ---
const http = createServer(async (req, res) => {
  log(`http ${req.method} ${req.url}`); // proves Miro loaded the app iframe
  const path = new URL(req.url, ORIGIN).pathname; // Miro appends ?_miro=...&_sdk=...
  if (path !== '/' && path !== '/index.html') return res.writeHead(404).end();
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    // only Miro may embed the app; otherwise any website could iframe it, pose as a board and feed the AI fake data
    'Content-Security-Policy': 'frame-ancestors https://miro.com https://*.miro.com',
    'Cache-Control': 'no-store', // an update must reach the board on the next load
  });
  res.end((await readFile(new URL('./app/index.html', import.meta.url), 'utf8')).replaceAll('__VERSION__', VERSION));
});

// --- WebSocket. Two kinds of peers:
//  board: the app page we serve, inside Miro (browser, Origin = our page)
//  client: another MiroBridgeMCP process (a second AI app: Antigravity, Cursor, ...) on /peer. Browsers always send
//          an Origin header, so a web page cannot pose as one.
let board = null;
let upstream = null; // set when another MiroBridgeMCP owns the port: we forward everything to it
const pending = new Map();
const wss = new WebSocketServer({
  server: http,
  verifyClient: ({ origin, req }) => {
    if (req.url === '/peer') return !origin;
    const ok = origin === ORIGIN || origin === `http://127.0.0.1:${PORT}`;
    if (!ok) log(`rejected websocket from origin ${origin}`);
    return ok;
  },
});
wss.on('error', () => {}); // ws re-emits the http server's errors; those are handled on `http` below
function onReply(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  clearTimeout(p.timer);
  msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
}
const boards = []; // all open board tabs; newest one gets commands (closing others would make them reconnect-fight)
wss.on('connection', (ws, req) => {
  if (req.url === '/peer') {
    log('another AI client is sharing this bridge');
    ws.on('message', async (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      const reply = await call(m.op, m.params).then((result) => ({ id: m.id, result }), (e) => ({ id: m.id, error: e.message }));
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(reply));
    });
    return;
  }
  boards.push(ws);
  board = ws;
  log(`board connected (${boards.length} open)`);
  ws.on('message', (raw) => {
    if (String(raw).startsWith('{"hello"')) { ws.appVersion = JSON.parse(raw).hello; return; } // app reports its version
    onReply(raw);
  });
  ws.on('close', () => {
    boards.splice(boards.indexOf(ws), 1);
    if (board === ws) board = boards.at(-1) ?? null;
    log(`board disconnected (${boards.length} open)`);
  });
});

// Own the port, or share the MiroBridgeMCP that already owns it. If that one exits, take over the port.
let portError = null;
const listen = () => http.listen(PORT, '127.0.0.1');
http.on('listening', () => { portError = null; log(`app + bridge on ${ORIGIN}`); });
http.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') { portError = e; return log(`cannot listen on ${PORT}:`, e.message); }
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/peer`);
  ws.on('open', () => { upstream = ws; portError = null; log(`sharing the MiroBridgeMCP already running on port ${PORT}`); });
  ws.on('message', onReply);
  ws.on('error', () => {}); // 'close' follows
  ws.on('close', () => {
    if (upstream === ws) upstream = null;
    else portError = e; // port held by something that is not MiroBridgeMCP
    setTimeout(() => { http.close(); listen(); }, 1000);
  });
});
listen();

// Control ops start with "__" and are answered by whichever process owns the port (peers forward them there).
function control(op) {
  if (op === '__status') {
    return { version: VERSION, mode: MODE, pid: process.pid, boards: boards.length, appVersion: board?.appVersion ?? null };
  }
  if (op === '__shutdown') { // used by setup/uninstall to replace an old service; AI-app sessions never exit on request
    if (MODE === 'serve') setTimeout(() => process.exit(0), 100);
    return { stopping: MODE === 'serve' };
  }
  throw new Error(`Unknown control op ${op}`);
}

function call(op, params = {}) {
  if (op.startsWith('__') && !upstream) {
    try { return Promise.resolve(control(op)); } catch (e) { return Promise.reject(e); }
  }
  const target = board ?? upstream;
  if (!target && portError) return Promise.reject(new Error(`Bridge port ${PORT} is used by another program (${portError.code}). Set MIRO_BRIDGE_PORT and the Miro app's App URL to a free port.`));
  if (!target) return Promise.reject(new Error(`No Miro board connected. Ask the user to check: 1) the MiroBridgeMCP app is installed in the board's team, 2) a board of that team is open in Chrome/Edge or the Miro desktop app, 3) reload the board tab once (needed if the board was opened before this AI app started). Brave: allow localhost access for miro.com. Diagnose with: miro-bridge-mcp check (re-run miro-bridge-mcp setup to repair)`));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Board did not answer "${op}" within ${TIMEOUT_MS / 1000}s`)); }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    target.send(JSON.stringify({ id, op, params }));
  });
}

// --- MCP tools ---
const mcp = new McpServer({ name: 'MiroBridgeMCP', title: 'Miro Bridge', version: VERSION, icons: SERVER_ICON });
// hints let clients auto-approve reads and ask before destructive calls
const READ_ONLY = new Set(['get_board_info', 'get_focus', 'get_items', 'get_selection', 'zoom_to', 'capture']);
const annotationsFor = (name) => ({ readOnlyHint: READ_ONLY.has(name), destructiveHint: name === 'delete_items', openWorldHint: false });
const tool = (name, description, inputSchema, run = (args) => call(name, args)) =>
  mcp.registerTool(name, { description, inputSchema, annotations: annotationsFor(name) }, async (args) => {
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
  const items = await call('get_items');
  // a focused frame brings its children and loose items lying on top of it (API-created items are often not parented)
  const frames = items.filter((i) => i.type === 'frame' && ids.has(i.id));
  const onFrame = (i) => !i.parentId && i.type !== 'frame' && typeof i.x === 'number' && frames.some((f) =>
    Math.abs(i.x - f.x) <= f.width / 2 && Math.abs(i.y - f.y) <= f.height / 2);
  const inFocus = new Set(items.filter((i) => ids.has(i.id) || ids.has(i.parentId) || onFrame(i)).map((i) => i.id));
  // plus connectors linking two focused items: they carry the relationships
  return items.filter((i) => inFocus.has(i.id) || (i.type === 'connector' && inFocus.has(i.start?.item) && inFocus.has(i.end?.item)));
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
    const out = { id: info.id, counts, frames, focus: focus ? `${focus} item(s) marked; call get_focus first` : 'none' };
    const app = (await call('__status').catch(() => null))?.appVersion;
    if (app !== VERSION) out.warning = `The board runs app v${app ?? 'unknown'} but the bridge is v${VERSION}; ask the user to reload the board tab once.`;
    return out;
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
// The SDK's McpServer has no per-tool icons option yet: add them to tools/list (spec 2025-11 Tool.icons).
// shortcut: wraps a private handler map of @modelcontextprotocol/sdk 1.32; test.js fails loudly if an upgrade breaks it.
const listTools = mcp.server._requestHandlers.get('tools/list');
mcp.server._requestHandlers.set('tools/list', async (...a) => {
  const r = await listTools(...a);
  for (const t of r.tools) if (TOOL_ICONS[t.name]) t.icons = TOOL_ICONS[t.name];
  return r;
});

if (command === 'setup') await setup();
else if (command === 'config') { console.log(configText()); process.exit(0); }
else if (command === 'check' || process.argv.includes('--check')) await check();
else if (command === 'uninstall') await uninstall();
else if (command === 'serve') log(`service ${VERSION} started (pid ${process.pid})`); // keeps running: http + ws only
else if (command && command !== 'mcp') { console.log(`Unknown command "${command}". Commands: setup, check, config, uninstall (no command = MCP server for an AI app)`); process.exit(1); }
else await mcp.connect(new StdioServerTransport());

// Ask the process that owns the port (if it is an old service) to exit, then start ours. Returns a status line.
async function startService(self) {
  const status = await call('__status').catch(() => null);
  if (status?.mode === 'serve' && status.version === VERSION) return `already running (v${VERSION}, pid ${status.pid})`;
  if (status?.mode === 'serve') { await call('__shutdown').catch(() => {}); await new Promise((r) => setTimeout(r, 1500)); }
  spawn(process.execPath, [self, 'serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return status?.mode === 'serve' ? `restarted (v${status.version} -> v${VERSION})` : `started (v${VERSION})`;
}

async function uninstall() {
  console.log('MiroBridgeMCP uninstall');
  console.log(`${removeAutostart() ? 'OK  ' : '... '} login service ${'removed'}`);
  const r = await call('__shutdown').catch(() => null);
  console.log(`${r?.stopping ? 'OK   running service stopped' : '...  no running service'}`);
  try { execSync('claude mcp remove MiroBridgeMCP -s user', { stdio: 'ignore' }); console.log('OK   removed from Claude Code'); } catch { console.log('...  not registered in Claude Code'); }
  console.log('...  other AI apps: delete the "MiroBridgeMCP" entry from their MCP config. Then: npm rm -g miro-bridge-mcp');
  process.exit(0);
}

// node + absolute path: starts fast, needs no network, and avoids the Windows "cmd /c npx" quirk
function selfPath() { return fileURLToPath(import.meta.url).replaceAll('\\', '/'); }

// `miro-bridge-mcp config`: ready-to-paste config for every common MCP client
function configText() {
  const p = selfPath();
  const json = (key, extra = {}) => JSON.stringify({ [key]: { MiroBridgeMCP: { ...extra, command: 'node', args: [p] } } }, null, 2);
  return `Add MiroBridgeMCP to your AI app (any MCP client that runs local "stdio" servers):

Claude Code
  claude mcp add MiroBridgeMCP -s user -- node "${p}"

Antigravity, Cursor, Windsurf, Claude Desktop, Gemini CLI, Cline, ... (their MCP JSON config, key "mcpServers")
${json('mcpServers')}

VS Code / GitHub Copilot (mcp.json, key "servers")
${json('servers', { type: 'stdio' })}

OpenAI Codex CLI (~/.codex/config.toml)
  [mcp_servers.MiroBridgeMCP]
  command = "node"
  args = ["${p}"]

Restart the app after adding it. Several apps can be open at once: they share one bridge.
ChatGPT (web/desktop) only accepts remote HTTPS MCP servers, so it cannot use this local server.`;
}

// `miro-bridge-mcp check`: setup diagnosis for people installing it (prints to stdout; not an MCP session)
// `miro-bridge-mcp setup`: register with Claude Code if present, open the Miro app install page, wait for a board. Safe to re-run (repairs).
async function setup() {
  const dry = Boolean(process.env.MIRO_BRIDGE_DRY_RUN);
  const self = selfPath();
  console.log('MiroBridgeMCP setup');
  if (self.includes('/_npx/')) {
    console.log('FAIL this copy lives in the npx cache, which gets cleaned up. Install it once, then run setup:\n' +
      '     npm install -g github:sawaddee123/MiroBridgeMCP\n     miro-bridge-mcp setup');
    process.exit(1);
  }
  const add = `claude mcp add MiroBridgeMCP -s user -- node "${self}"`;
  if (dry) console.log(`DRY  ${add}`);
  else {
    try { execSync('claude mcp remove MiroBridgeMCP -s user', { stdio: 'ignore' }); } catch {} // re-run = repair
    try { execSync(add, { stdio: 'ignore' }); console.log('OK   registered with Claude Code as "MiroBridgeMCP"'); }
    catch { console.log('...  Claude Code not found, skipped (fine if you use another AI app)'); }
  }
  console.log('...  other AI apps (Antigravity, Cursor, VS Code, Codex...): run `miro-bridge-mcp config` and paste the snippet for your app');
  if (dry) { console.log(`DRY  login service: node "${self}" serve\n...  install the Miro app: ${INSTALL_URL}`); process.exit(0); }
  // background service at login: boards opened before any AI app still load the app (no F5 needed)
  console.log(`OK   login service: ${installAutostart(process.execPath, self)}`);
  await new Promise((r) => setTimeout(r, 300)); // let this process find out whether a bridge already owns the port
  console.log(`OK   bridge service ${await startService(self)}`);
  let seen = false; // an open board reconnects within ~2s; if one does, the Miro app is already installed
  for (let i = 0; i < 10 && !seen; i++) {
    seen = await call('__status').then((s) => s.boards > 0).catch(() => false);
    if (!seen) await new Promise((r) => setTimeout(r, 500));
  }
  if (seen) console.log('OK   a board is already connected, so the Miro app is installed');
  else {
    console.log(`...  install the Miro app into the team that owns your boards (opening it in your browser):\n     ${INSTALL_URL}`);
    const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', INSTALL_URL]] // no cmd.exe: the URL has "&"
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [INSTALL_URL]];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  }
  await check(300);
}

async function check(defaultWait = 90) {
  const say = (ok, msg) => console.log(`${ok ? 'OK  ' : 'FAIL'} ${msg}`);
  say(Number(process.versions.node.split('.')[0]) >= 20, `Node ${process.version} (need 20+)`);
  await new Promise((r) => setTimeout(r, 500));
  if (portError) { say(false, `port ${PORT}: ${portError.code}, used by another program. Set MIRO_BRIDGE_PORT and the Miro app's App URL to a free port.`); process.exit(1); }
  const owner = await call('__status').catch(() => null);
  say(true, upstream ? `bridge on ${ORIGIN} run by ${owner?.mode === 'serve' ? 'the background service' : 'an AI app'} (v${owner?.version}${owner?.version !== VERSION ? `, this install is v${VERSION}: run setup to restart it` : ''})`
    : `bridge listening on ${ORIGIN} (no background service running: run setup so boards connect without F5)`);
  say(autostartInstalled(), autostartInstalled() ? 'starts at login' : 'not set to start at login (run setup)');
  const waitS = Number(process.env.MIRO_BRIDGE_CHECK_WAIT || defaultWait);
  console.log(`...  open or reload a Miro board where the MiroBridgeMCP app is installed (waiting ${waitS}s)`);
  let info, last;
  for (const end = Date.now() + waitS * 1000; !info && Date.now() < end;) {
    info = await call('get_board_info').catch((e) => { last = e; });
    if (!info) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!info) {
    say(false, /No Miro board/.test(last?.message) ? 'no board connected. Check: app installed in the board team? board tab reloaded (F5)? ' +
      'Brave: allow localhost access for miro.com. Safari is not supported.' : `board not answering: ${last?.message}`);
    process.exit(1);
  }
  const items = await call('get_items');
  say(true, `board connected: ${info.id} (${items.length} items)`);
  const app = (await call('__status').catch(() => ({}))).appVersion;
  say(app === VERSION, app === VERSION ? `board app v${app} is current` : `board app is v${app ?? 'old'}, bridge is v${VERSION}: reload the board tab once`);
  const actions = (await call('get_app_status').catch(() => null))?.actions ?? {};
  const n = Object.keys(actions).length;
  say(n === 3, n === 3 ? 'right-click menu ready (select items → right-click → "Focus AI here")' : `right-click menu: ${n}/3 actions registered (the app icon still works)`);
  console.log('Ready: (re)start your AI app and ask it about the board.');
  process.exit(0);
}
