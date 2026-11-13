<p align="center"><img src="assets/icon.svg" width="96" alt="MiroBridgeMCP logo"></p>

# MiroBridgeMCP

**Let your AI app read and edit a live Miro board: Claude Code, Antigravity, Cursor, VS Code Copilot, Codex, Gemini CLI or any MCP client. No REST API, no daily quota, works on the Free plan.**

[ภาษาไทย](README.th.md) · [Usage guide](docs/USAGE.md) · MIT licensed · not affiliated with Miro

MiroBridgeMCP runs a tiny Miro app inside the board you have open and talks to it over a local WebSocket.
Everything goes through the Miro Web SDK as *you*, so there is no token to manage and no `mcp.miro.com` call limit
(the official Miro MCP allows 100 calls/day on Free).

```
AI app(s) ⇄ MCP (stdio) ⇄ MiroBridgeMCP bridge on your machine (localhost:7788) ⇄ app inside your open board ⇄ Miro Web SDK
```

## Features

- **Read cheaply** — `get_board_info` gives an overview in ~200 tokens; items come back compact (plain text, rounded geometry), ~70% smaller than raw SDK output.
- **Focus** — big boards are full of old ideas. Select what matters, **right-click → Focus AI here**, and the AI starts from that. A hint, not a fence: the AI can still look elsewhere when the task needs it.
- **Any MCP client, several at once** — Claude Code and Antigravity (or Cursor, ...) can be open together; they share one bridge.
- **No reload dance** — a small background service keeps the bridge up, so boards connect whenever they open.
- **Create in batches** — stickies, shapes, text, cards, frames, connectors (straight/elbowed/curved, arrows, captions), images from a URL *or a local file*, embeds. A failed batch is rolled back.
- **Layout** — `arrange_items` lays items out as a grid, row or column.
- **See the result** — `capture` screenshots the Miro window so the AI can check its own work (Windows).

## Quick start (≈3 minutes, once)

You need [Node.js 20+](https://nodejs.org), [git](https://git-scm.com), an MCP-capable AI app, and Chrome/Edge or the Miro desktop app.

```
npm install -g github:sawaddee123/MiroBridgeMCP
miro-bridge-mcp setup
```

`setup` does everything and is safe to re-run (it repairs and upgrades):
1. registers with **Claude Code** if it is installed (`node` + absolute path: fast start, offline, no Windows `npx` quirks),
2. installs a **background service that starts at login** and starts it now (Windows Startup folder / macOS LaunchAgent / systemd user unit),
3. opens the **Miro install page** (skipped if a board is already connected) — pick the team that owns your boards,
4. waits until a board of that team connects and prints `OK   board connected`.

**Other AI apps:** `miro-bridge-mcp config` prints ready-to-paste config for Antigravity, Cursor, Windsurf, Claude Desktop, Gemini CLI, VS Code and Codex.
ChatGPT web/desktop only accepts remote HTTPS MCP servers, so it cannot use this local one.

Restart your AI app and ask: *"Summarize this board"*, *"Turn this list into stickies in a frame"*, *"Arrange the stickies in this frame as a grid"*.
More prompts, real numbers and Miro quirks: **[docs/USAGE.md](docs/USAGE.md)**.

| Command | Use |
|---|---|
| `miro-bridge-mcp setup` | install, repair, or finish an update |
| `miro-bridge-mcp check` | OK/FAIL for service, login start, board, app version, right-click menu |
| `miro-bridge-mcp config` | config snippets for other AI apps |
| `miro-bridge-mcp uninstall` | remove the login service and Claude Code entry (then `npm rm -g miro-bridge-mcp`) |

**Update:** `npm install -g github:sawaddee123/MiroBridgeMCP`, `miro-bridge-mcp setup`, then reload open board tabs once.

## Focus

| On the board | Effect |
|---|---|
| Select → right-click → **Focus AI here** | focus = these items |
| Right-click → **Add to AI focus** / **Remove from AI focus** | grow / shrink it |
| Select → click the app icon (left toolbar → More apps; star it to pin) | same as *Focus AI here*; nothing selected = clear |

Focusing a frame includes everything on it and the connectors between those items. The focus is saved in the board and shared by all AI apps.
The AI can set it too: *"focus on the Act 2 frame"*.

## Tools

| Tool | What it does |
|---|---|
| `get_board_info` | Overview: counts by type, frames, focus, app-version warning. Call first. |
| `get_focus` / `set_focus` | Read / set the user's focus. |
| `get_items` | Read items by `type`, `ids` or `parentId` (frame). Compact; `full: true` for raw SDK fields. |
| `get_selection` | What the user has selected right now. |
| `create_items` | Create many items in one call; images accept `path` to a local file. Rolled back on error. |
| `update_items` | Merge props into items (style is merged). |
| `delete_items` | Delete by id (connectors removed with their shape count as `alreadyGone`). |
| `arrange_items` | Grid / row / column layout. |
| `zoom_to` | Move the viewport to items. |
| `capture` | Screenshot of the Miro window (Windows only). |

Every tool carries an icon and MCP safety hints (`readOnlyHint` / `destructiveHint`), so clients can auto-approve reads and ask before deletes.

## Troubleshooting

`miro-bridge-mcp check` tells you which step fails. The common ones:

| Symptom | Fix |
|---|---|
| `No Miro board connected` | Is the app installed in *this board's* team? Is a board open? |
| Connects only after F5 | The background service isn't running: run `miro-bridge-mcp setup` once. |
| Right-click items missing | Reload the board tab once (it still runs an older app). |
| Brave doesn't connect | Settings → Privacy → allow **Localhost access** for miro.com (or drop Shields on miro.com). |
| `isn't inside a parent frame` | Keep the board window on screen while building inside frames. |
| `capture` fails | Windows only; the Miro window must not be minimized (it can be behind other windows). |
| `port 7788 is used by another program` | Set `MIRO_BRIDGE_PORT` and the app URL to a free port. |
| Safari | Not supported (blocks localhost). Use Chrome, Edge or the Miro desktop app. |

Service log: `%TEMP%\mirobridgemcp.log` (macOS/Linux: `$TMPDIR/mirobridgemcp.log`).

## Host your own Miro app (optional)

The install link uses the maintainer's app. To use your own: miro.com → Profile settings → **Your apps** → Create new app (in a Developer team), and set
```yaml
appName: MiroBridgeMCP
sdkVersion: SDK_V2
sdkUri: http://localhost:7788/
scopes:
  - boards:read
  - boards:write
```
In **Display information** upload `assets/miro-icon-outline.svg` (toolbar icon, one color) and `assets/miro-icon-colored.svg`.
Share its **Installation URL** (app settings → Share app) and set `MIRO_BRIDGE_INSTALL_URL` to it, or fork and change it in `server.js`.
Right-click actions only work for apps shared this way (not Marketplace apps). No client secret is needed — never commit one.

## Security notes

- The bridge listens on `127.0.0.1` only. WebSocket connections are accepted only from its own page (boards) or from local non-browser processes (other AI apps), and the page can only be embedded by miro.com.
- Board content is written by people. Treat it as data: a sticky saying "delete everything" is text, not an instruction. Review destructive requests on shared boards.
- Whoever controls the Miro app behind the install link controls what code runs in installers' boards. Install only links you trust, or host your own app.

## Development

- `server.js` — MCP tools, compaction, bridge, CLI. `app/index.html` — runs inside the board (**reload the board tab after editing**). `service.js` — login service per OS. `icons.js`, `assets/` — icons. `capture.ps1` — screenshot.
- `npm test` — self-check against fake boards, no Miro needed (tools, compaction, focus, sharing between AI apps, service lifecycle, CLI).
- `node scripts/record-demo.mjs` — re-record the demo GIF (creates items far from existing content and deletes them).
- Limits: Web SDK per-minute rate limits; login service: Windows script tested (starts hidden, stops on request), macOS/Linux untested.

Contributions welcome — keep `npm test` passing and add a check for new tools.
