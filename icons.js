// MCP icons (spec 2025-11: servers and tools may carry icons). SVG data URIs, 24x24 line glyphs on currentColor-free strokes
// so they read on light and dark themes. The server icon is assets/icon.svg.
import { readFileSync } from 'node:fs';

const uri = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
const glyph = (body, color = '#5b4fd6') =>
  [{ src: uri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`), mimeType: 'image/svg+xml', sizes: ['any'] }];

export const SERVER_ICON = [{ src: uri(readFileSync(new URL('./assets/icon.svg', import.meta.url), 'utf8')), mimeType: 'image/svg+xml', sizes: ['any'] }];

export const TOOL_ICONS = {
  get_board_info: glyph('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
  get_focus: glyph('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="#5b4fd6"/>'),
  set_focus: glyph('<circle cx="12" cy="12" r="8"/><path d="M12 1v5M12 18v5M1 12h5M18 12h5"/>'),
  get_items: glyph('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  get_selection: glyph('<path d="M4 4l7 17 2.5-7.5L21 11z"/>'),
  create_items: glyph('<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 8v8M8 12h8"/>', '#1f9d6b'),
  update_items: glyph('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  delete_items: glyph('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>', '#c0392b'),
  arrange_items: glyph('<rect x="3" y="3" width="5" height="5" rx="1"/><rect x="10" y="3" width="5" height="5" rx="1"/><rect x="17" y="3" width="4" height="5" rx="1"/><rect x="3" y="12" width="5" height="5" rx="1"/><rect x="10" y="12" width="5" height="5" rx="1"/><path d="M3 21h18"/>'),
  zoom_to: glyph('<circle cx="10.5" cy="10.5" r="7"/><path d="M21 21l-5.5-5.5M10.5 7.5v6M7.5 10.5h6"/>'),
  capture: glyph('<path d="M4 7h3l2-3h6l2 3h3v13H4z"/><circle cx="12" cy="13" r="4"/>'),
};
