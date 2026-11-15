// Self-check: MCP client -> server.js -> WebSocket -> fake board. No Miro needed.
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PORT = 7799;
const VERSION = JSON.parse((await import('node:fs')).readFileSync('package.json', 'utf8')).version;
const client = new Client({ name: 'test', version: '0' });
await client.connect(new StdioClientTransport({ command: 'node', args: ['server.js'], env: { ...process.env, MIRO_BRIDGE_PORT: String(PORT) }, stderr: 'ignore' }));
await new Promise((r) => setTimeout(r, 300));

const tools = (await client.listTools()).tools.map((t) => t.name);
assert.deepEqual(tools.sort(), ['arrange_items', 'capture', 'create_items', 'create_table', 'delete_items', 'get_board_info', 'get_focus', 'get_items', 'get_selection', 'group_items', 'reorder_items', 'set_focus', 'update_items', 'zoom_to']);

let r = await client.callTool({ name: 'get_board_info', arguments: {} });
assert.ok(r.isError && /No Miro board connected/.test(r.content[0].text), 'errors when no board');

const res = await fetch(`http://localhost:${PORT}/?_miro=1.106254.0&_sdk=stable`);
assert.ok(res.headers.get('content-security-policy')?.includes('frame-ancestors https://miro.com'), 'only Miro may embed the app');
const page = await res.text();
assert.match(page, /miro\.board/, 'serves app page with the query string Miro adds');

const evil = new WebSocket(`ws://localhost:${PORT}`, { origin: 'https://evil.example' });
await new Promise((res) => { evil.on('error', res); evil.on('open', () => assert.fail('foreign origin accepted')); });

const fake = new WebSocket(`ws://localhost:${PORT}`, { origin: `http://localhost:${PORT}` });
// shaped like real Web SDK items (noise fields included) so compaction is exercised
const RAW = [
  { id: 'f1', type: 'frame', title: 'Retro', x: 0.4, y: 0, width: 800, height: 600, childrenIds: ['s1'], style: { fillColor: '#ffffff' }, createdAt: 't', createdBy: 'u' },
  { id: 's1', type: 'sticky_note', content: '<p>Flaky &amp; slow</p>', x: 200.2, y: 220, width: 199, height: 228, parentId: 'f1', style: { fillColor: 'light_pink', textAlign: 'center' }, modifiedAt: 't', connectorIds: [], relativeTo: 'parent_top_left' },
  { id: 'c1', type: 'connector', shape: 'curved', start: { item: 's1', position: {} }, end: { item: 'f1' }, style: { strokeColor: '#000' }, captions: [{ content: '<p>fix</p>', position: 0.5 }] },
  { id: 'o1', type: 'text', content: 'on frame, not parented', x: 100, y: 100, width: 10, height: 10 },
  { id: 'far', type: 'text', content: 'elsewhere', x: 5000, y: 0, width: 10, height: 10 },
];
const EXTRA = [{ id: 's2', type: 'sticky_note', content: 'b', x: 600, y: 100, width: 100, height: 100, parentId: 'f1' }, { id: 'loose', type: 'text', x: 0, y: 0, width: 10, height: 10 },
  { id: 't1', type: 'unsupported', x: 0, y: 0, width: 900, height: 300 }];
let lastParams, lastCreate;
let focusIds = [];
let zoomCalls = 0;
fake.on('message', (raw) => {
  const { id, op, params } = JSON.parse(raw);
  lastParams = params;
  if (op === 'create_items') lastCreate = params;
  if (op === 'zoom_to') { zoomCalls++; return fake.send(JSON.stringify({ id, error: 'Board is not rendering (window covered or minimized)' })); }
  const result = op === 'get_board_info' ? { id: 'b1', createdAt: 't' }
    : op === 'get_focus_ids' ? focusIds
    : op === 'set_focus' ? ((focusIds = params.ids), { focus: params.ids.length })
    : op === 'get_items' && params.ids ? [...RAW, ...EXTRA].filter((i) => params.ids.includes(i.id))
    : op === 'get_items' || op === 'get_selection' ? RAW
    : op === 'create_items' ? params.items.map((it, n) => ({ id: `n${n}`, type: it.type, ...it.props, createdBy: 'u' }))
    : op === 'group' ? { id: 'g1', type: 'group', itemsIds: params.ids }
    : { op, params };
  fake.send(JSON.stringify(op === 'delete_items' ? { id, error: 'boom' } : { id, result }));
});
await new Promise((res) => fake.on('open', res));
const json = (r) => JSON.parse(r.content[0].text);

// a board running an old app gets a reload warning; the real app says hello with its version
r = await client.callTool({ name: 'get_board_info', arguments: {} });
assert.match(json(r).warning, /reload the board tab/);
fake.send(JSON.stringify({ hello: VERSION }));
await new Promise((res) => setTimeout(res, 100));

// tools carry icons (spec 2025-11) and safety hints; the server carries its icon
const listed = (await client.listTools()).tools;
assert.ok(listed.every((x) => x.icons?.[0]?.src.startsWith('data:image/svg+xml;base64,')), 'every tool has an icon');
assert.equal(listed.find((x) => x.name === 'get_items').annotations.readOnlyHint, true);
assert.equal(listed.find((x) => x.name === 'delete_items').annotations.destructiveHint, true);
assert.ok(client.getServerVersion().icons?.length, 'server icon');

r = await client.callTool({ name: 'get_board_info', arguments: {} });
assert.deepEqual(json(r), { id: 'b1', counts: { frame: 1, sticky_note: 1, connector: 1, text: 2 }, frames: [{ id: 'f1', title: 'Retro', children: 1 }], focus: 'none' });

// focus: a focused frame brings its children; overview tells Claude a focus exists
assert.deepEqual(json(await client.callTool({ name: 'get_focus', arguments: {} })), []);
await client.callTool({ name: 'set_focus', arguments: { ids: ['f1'] } });
assert.deepEqual(json(await client.callTool({ name: 'get_focus', arguments: {} })).map((i) => i.id), ['f1', 's1', 'c1', 'o1'], 'frame focus = children + loose items on it + connectors between them');
assert.match(json(await client.callTool({ name: 'get_board_info', arguments: {} })).focus, /1 item/);
await client.callTool({ name: 'set_focus', arguments: { ids: [] } });

r = await client.callTool({ name: 'get_items', arguments: { parentId: 'f1' } });
assert.deepEqual(json(r), [{ id: 's1', type: 'sticky_note', content: 'Flaky & slow', x: 200, y: 220, width: 199, height: 228, parentId: 'f1', fill: 'light_pink' }]);
assert.ok(!r.content[0].text.includes('\n'), 'minified output');

r = await client.callTool({ name: 'get_items', arguments: {} });
assert.deepEqual(json(r)[2], { id: 'c1', type: 'connector', shape: 'curved', from: 's1', to: 'f1', captions: ['fix'] });

r = await client.callTool({ name: 'get_items', arguments: { full: true } });
assert.equal(json(r)[0].createdBy, 'u', 'full:true keeps raw fields');

r = await client.callTool({ name: 'create_items', arguments: { items: [{ type: 'sticky_note', props: { content: 'hi', x: 1 } }] } });
assert.deepEqual(json(r), [{ id: 'n0', type: 'sticky_note', content: 'hi', x: 1 }]);

// local image path is sent to the board as a data URL; the data URL is not echoed back to Claude
const png = join(tmpdir(), 'mirobridgemcp-test.png');
writeFileSync(png, Buffer.from([137, 80, 78, 71]));
r = await client.callTool({ name: 'create_items', arguments: { items: [{ type: 'image', props: { path: png, x: 0 } }] } });
assert.deepEqual(lastParams.items[0].props, { x: 0, url: 'data:image/png;base64,iVBORw==' });
assert.deepEqual(json(r), [{ id: 'n0', type: 'image', x: 0 }]);
r = await client.callTool({ name: 'create_items', arguments: { items: [{ type: 'image', props: { path: 'C:/x/notes.txt' } }] } });
assert.ok(r.isError && /Not an image file/.test(r.content[0].text));
// drawings: inline svg becomes a data URL
await client.callTool({ name: 'create_items', arguments: { items: [{ type: 'image', props: { svg: '<svg/>', x: 0 } }] } });
assert.deepEqual(lastParams.items[0].props, { x: 0, url: 'data:image/svg+xml;base64,PHN2Zy8+' });

// tables: unreadable through the SDK, so compact output says how to see one
r = await client.callTool({ name: 'get_items', arguments: { ids: ['t1'] } });
assert.match(json(r)[0].note, /table.*capture/);
// create_table: ragged rows padded, HTML escaped, x/y = top-left, cells grouped
r = await client.callTool({ name: 'create_table', arguments: { rows: [['A', 'B'], ['<1>']], x: 0, y: 0, colWidth: 100, rowHeight: 50 } });
assert.deepEqual(json(r), { group: 'g1', rows: 2, columns: 2, cells: ['n0', 'n1', 'n2', 'n3'] });
assert.deepEqual(lastCreate.items.map((i) => [i.props.content, i.props.x, i.props.y]), [['A', 50, 25], ['B', 150, 25], ['&lt;1&gt;', 50, 75], ['', 150, 75]]);
assert.equal(lastCreate.items[0].props.style.fillColor, '#e6e6e6', 'header row shaded');

// a board that is not rendering: the bridge raises the Miro window once and retries (Windows), else passes the error on
r = await client.callTool({ name: 'zoom_to', arguments: { ids: ['s1'] } });
assert.ok(r.isError && /not rendering/.test(r.content[0].text));
assert.equal(zoomCalls, process.platform === 'win32' && !/Could not bring/.test(r.content[0].text) ? 2 : 1, r.content[0].text);

// arrange: ids order kept, uniform cells from largest item (199x228), starts at the items' top-left (101, 50)
r = await client.callTool({ name: 'arrange_items', arguments: { ids: ['s2', 's1', 'c1'], layout: 'row', gap: 40 } });
assert.deepEqual(json(r), { moved: 2, columns: 2 });
assert.deepEqual(lastParams.items, [{ id: 's2', props: { x: 200, y: 164 } }, { id: 's1', props: { x: 439, y: 164 } }]);
r = await client.callTool({ name: 'arrange_items', arguments: { ids: ['s1', 'loose'] } });
assert.ok(r.isError && /different frames/.test(r.content[0].text));

r = await client.callTool({ name: 'delete_items', arguments: { ids: ['1'] } });
assert.ok(r.isError && r.content[0].text === 'boom', 'board errors reach Claude');

// second tab takes over; closing it falls back to the first instead of dropping the bridge
const tab2 = new WebSocket(`ws://localhost:${PORT}`, { origin: `http://localhost:${PORT}` });
tab2.on('message', (raw) => tab2.send(JSON.stringify({ id: JSON.parse(raw).id, result: [{ id: 'tab2', type: 'text' }] })));
await new Promise((res) => tab2.on('open', res));
await new Promise((r) => setTimeout(r, 100));
r = await client.callTool({ name: 'get_selection', arguments: {} });
assert.equal(json(r)[0].id, 'tab2', 'newest tab gets commands');
tab2.close();
await new Promise((r) => setTimeout(r, 100));
r = await client.callTool({ name: 'get_selection', arguments: {} });
assert.equal(json(r)[0].id, 'f1', 'falls back to older tab');

// a browser page cannot pose as another AI app on /peer (browsers always send Origin)
const fakePeer = new WebSocket(`ws://localhost:${PORT}/peer`, { origin: `http://localhost:${PORT}` });
await new Promise((res) => { fakePeer.on('error', res); fakePeer.on('open', () => assert.fail('browser accepted as peer')); });

// a second AI app on the same port shares the first one's bridge...
const client2 = new Client({ name: 'test2', version: '0' });
await client2.connect(new StdioClientTransport({ command: 'node', args: ['server.js'], env: { ...process.env, MIRO_BRIDGE_PORT: String(PORT) }, stderr: 'ignore' }));
await new Promise((r) => setTimeout(r, 500));
r = await client2.callTool({ name: 'get_selection', arguments: {} });
assert.equal(json(r)[0].id, 'f1', 'second app reaches the board through the first');

fake.close();
await client.close();

// ...and takes over the port when the first app exits
await new Promise((r) => setTimeout(r, 2500));
const fake2 = new WebSocket(`ws://localhost:${PORT}`, { origin: `http://localhost:${PORT}` });
fake2.on('message', (raw) => fake2.send(JSON.stringify({ id: JSON.parse(raw).id, result: [{ id: 'z', type: 'text' }] })));
await new Promise((res) => fake2.on('open', res));
r = await client2.callTool({ name: 'get_selection', arguments: {} });
assert.equal(json(r)[0].id, 'z', 'second app took over the port');
fake2.close();
await client2.close();

// --check: passes once a board connects and answers
const { spawn } = await import('node:child_process');
const chk = spawn('node', ['server.js', '--check'], { env: { ...process.env, MIRO_BRIDGE_PORT: String(PORT + 1), MIRO_BRIDGE_CHECK_WAIT: '10' } });
let out = '';
await new Promise((r) => chk.stdout.on('data', (d) => { out += d; if (/listening/.test(out)) r(); }));
const b = new WebSocket(`ws://localhost:${PORT + 1}`, { origin: `http://localhost:${PORT + 1}` });
b.on('message', (raw) => { const { id, op } = JSON.parse(raw); b.send(JSON.stringify({ id, result: op === 'get_items' ? RAW : { id: 'b1' } })); });
const code = await new Promise((r) => chk.on('exit', r));
assert.equal(code, 0, out);
assert.ok(out.includes('board connected: b1 (5 items)'), out);
b.close();

// setup (dry run): registers node + this server.js's absolute path, never npx
const dry = (await import('node:child_process')).execFileSync('node', ['server.js', 'setup'], { env: { ...process.env, MIRO_BRIDGE_DRY_RUN: '1', MIRO_BRIDGE_PORT: String(PORT + 2) } }).toString();
assert.match(dry, /DRY {2}claude mcp add MiroBridgeMCP -s user -- node ".*\/server\.js"/, dry);
assert.ok(dry.includes('miro.com/app-install'), dry);

// config: one snippet per client family, all pointing at this server.js
const cfg = (await import('node:child_process')).execFileSync('node', ['server.js', 'config'], { env: { ...process.env, MIRO_BRIDGE_PORT: String(PORT + 3) } }).toString();
for (const s of ['claude mcp add MiroBridgeMCP', '"mcpServers"', '"servers"', '[mcp_servers.MiroBridgeMCP]']) assert.ok(cfg.includes(s), `config lacks ${s}`);
assert.ok(/"args": \[\s*".*\/server\.js"\s*\]/.test(cfg), cfg);
// serve: background service owns the port, answers status through a peer, exits when asked
const { spawn: sp } = await import('node:child_process');
const SVC = PORT + 4;
const svc = sp('node', ['server.js', 'serve'], { env: { ...process.env, MIRO_BRIDGE_PORT: String(SVC) }, stdio: 'ignore' });
await new Promise((res) => setTimeout(res, 800));
const peer = new WebSocket(`ws://127.0.0.1:${SVC}/peer`);
await new Promise((res) => peer.on('open', res));
const ask = (op) => new Promise((res) => { const id = op; peer.once('message', (m) => res(JSON.parse(m))); peer.send(JSON.stringify({ id, op, params: {} })); });
const st = await ask('__status');
assert.equal(st.result.mode, 'serve');
assert.equal(st.result.version, VERSION);
assert.deepEqual((await ask('__shutdown')).result, { stopping: true });
assert.equal(await new Promise((res) => svc.on('exit', res)), 0, 'service exits on request');
peer.close();

// unknown commands fail clearly instead of silently starting an MCP server
const bad = (await import('node:child_process')).spawnSync('node', ['server.js', 'setpu'], { env: { ...process.env, MIRO_BRIDGE_PORT: String(PORT + 5) } });
assert.equal(bad.status, 1);
assert.match(String(bad.stdout), /Unknown command "setpu"/);
console.log('ok: all checks passed');
