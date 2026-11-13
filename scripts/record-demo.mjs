// Records docs/demo.gif: drives an open board through a short scenario and captures each step.
// Usage: open a Miro board (window visible, not minimized), then `node scripts/record-demo.mjs`.
// Everything it creates is placed far from existing content and deleted at the end. Windows only (uses capture).
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = new URL('..', import.meta.url);
const frames = new URL('../docs/frames/', import.meta.url);
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });

const client = new Client({ name: 'record-demo', version: '0' });
await client.connect(new StdioClientTransport({ command: 'node', args: [new URL('../server.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], stderr: 'ignore' }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r.content[0].type === 'image' ? r.content[0] : JSON.parse(r.content[0].text);
};
for (let i = 0; ; i++) { try { await call('get_board_info'); break; } catch (e) { if (i > 60) throw e; await new Promise((r) => setTimeout(r, 2000)); } }

const X = Number(process.env.DEMO_X || 30000), Y = Number(process.env.DEMO_Y || 30000); // empty area
const made = [];
let n = 0;
const shot = async (ids) => {
  const img = await call('capture', { ids, maxWidth: 1400 });
  writeFileSync(new URL(`f${String(n++).padStart(2, '0')}.png`, frames), Buffer.from(img.data, 'base64'));
};
const say = async (text) => call('update_items', { items: [{ id: made[0], props: { content: `<p><strong>${text}</strong></p>` } }] });

try {
  const [caption] = await call('create_items', { items: [{ type: 'text', props: { content: '<p><strong>Claude, turn my launch tasks into a board</strong></p>', x: X + 300, y: Y - 520, width: 1500, style: { fontSize: 44, color: '#1a1a2e' } } }] });
  made.push(caption.id);
  const tasks = ['Write spec', 'Design UI', 'Build API', 'Write tests', 'Beta invite', 'Fix bugs', 'Launch post', 'Collect feedback'];
  const messy = await call('create_items', { items: tasks.map((t, i) => ({ type: 'sticky_note', props: { content: `<p>${t}</p>`, x: X + ((i * 397) % 1100) - 250, y: Y + ((i * 263) % 500) - 150, style: { fillColor: 'light_yellow' } } })) });
  made.push(...messy.map((s) => s.id));
  await say('1 · create_items: 8 stickies in one call');
  await shot(made);

  await call('arrange_items', { ids: messy.map((s) => s.id), layout: 'grid', columns: 4, gap: 40 });
  await say('2 · arrange_items: tidy 4-column grid');
  await shot(made);

  const colors = ['light_blue', 'light_blue', 'light_green', 'light_green', 'violet', 'violet', 'light_pink', 'light_pink'];
  await call('update_items', { items: messy.map((s, i) => ({ id: s.id, props: { style: { fillColor: colors[i] } } })) });
  await say('3 · update_items: color by phase');
  await shot(made);

  const phases = await call('create_items', { items: ['Plan', 'Build', 'Beta', 'Launch'].map((t, i) => ({ type: 'shape', props: { shape: 'round_rectangle', content: `<p><strong>${t}</strong></p>`, x: X - 150 + i * 240, y: Y + 520, width: 200, height: 90, style: { fillColor: '#efe3ff', fontSize: 28 } } })) });
  made.push(...phases.map((s) => s.id));
  const lines = await call('create_items', { items: phases.slice(1).map((s, i) => ({ type: 'connector', props: { start: { item: phases[i].id }, end: { item: s.id }, shape: 'elbowed', style: { endStrokeCap: 'arrow', strokeWidth: 3 } } })) });
  made.push(...lines.map((l) => l.id));
  await say('4 · create_items: phases + connectors');
  await shot(made);

  await say('5 · capture: Claude checks its own work');
  await shot(made);
} finally {
  if (made.length) await call('delete_items', { ids: made.reverse() }).catch((e) => console.error('cleanup failed:', e.message));
  await client.close();
}

// crop the browser chrome (tabs, board name, avatars) and build the gif; 1 frame = 2s
const out = new URL('../docs/demo.gif', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const pattern = new URL('f%02d.png', frames).pathname.replace(/^\/(\w:)/, '$1');
const vf = 'crop=iw:ih-100:0:100,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse';
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '0.5', '-i', pattern, '-vf', vf, '-loop', '0', out], { cwd: root });
rmSync(frames, { recursive: true, force: true });
console.log(`wrote ${out} (${n} frames)`);
