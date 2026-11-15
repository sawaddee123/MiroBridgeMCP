# Using MiroBridgeMCP day to day

Everything here was measured or observed on real boards (Windows 11, Miro desktop app, a 238-item board), not guessed.

## How it works in one picture

```
your AI app ──stdio──> MiroBridgeMCP ──┐
another AI app ─stdio─> MiroBridgeMCP ─┤ (shares the first one)
                                       ▼
                    bridge on localhost:7788 (background service, starts at login)
                                       │ WebSocket
                                       ▼
          MiroBridgeMCP app inside your open board (Miro Web SDK, runs as you)
```

- The Miro app is a hidden page served by the bridge on **your** machine. Board data goes board ⇄ your machine ⇄ your AI app. Nothing else.
- `setup` installs a small background service that starts at login, so a board opened at any time finds the bridge. AI apps start their own MiroBridgeMCP process, which joins the running bridge.

## First five minutes

1. `npm install -g github:sawaddee123/MiroBridgeMCP` then `miro-bridge-mcp setup`
2. Install the Miro app into your team when the browser opens (only the first time).
3. Open any board of that team. `setup` waits and prints `OK board connected`.
4. Other AI apps: `miro-bridge-mcp config` and paste your app's snippet.
5. Restart your AI app. Ask: *"What's on this board?"*

## Telling the AI what to look at: Focus

Large boards collect old ideas, drafts and references. Focus says "this is what we're working on".

| How | What happens |
|---|---|
| Select items → click the **app icon** in the left toolbar | Focus = those items; with nothing selected it clears the focus |
| Select items → **Focus AI here** / **Add to AI focus** / **Remove from AI focus** in the item toolbar *(beta)* | Replace / grow / shrink the focus |
| Tell the AI: *"focus on the Act 2 frame"* | The AI calls `set_focus` |

- Focusing a **frame** includes everything on it, even items lying on it without being attached, plus the connectors between them (measured: 1 frame → 48 items incl. 19 connectors).
- Focus is a **starting point, not a fence**. The AI reads it first and may still read the rest when the task needs it ("compare with the old version").
- The focus is saved in the board, so it is still there tomorrow and visible to every AI app.

Tip: pin the app icon (left toolbar → **More apps** → star it) so it's one click away.

## Prompts that work well

| You say | The AI does |
|---|---|
| "Summarize this board" | overview → reads frames one by one (≈2k tokens instead of ≈60k) |
| "Summarize the focus as a diagram next to it" | reads focus → creates frame, boxes, elbowed connectors |
| "Turn this list into stickies in a 4-column grid" | one `create_items` + one `arrange_items` |
| "Color the stickies by status" | one `update_items` for all of them |
| "Connect A to B with an arrow labeled *needs*" | one connector with a caption |
| "Put C:/designs/mock.png next to the title" | uploads a local image |
| "Take a screenshot and check the layout" | `capture` (Windows), then fixes overlaps |
| "Find contradictions between the drafts" | reads the frames and marks issues with stickies |

## Real numbers

| Action | Cost / time |
|---|---|
| Board overview (`get_board_info`) | ~185 tokens |
| Read a whole 238-item board | 16.6k tokens (raw SDK output would be 58k) |
| Read one frame | ~560 tokens for 12 items |
| Create 12 stickies in a frame | ~3 s, one call |
| Create 5 connectors | ~1.2 s |
| Delete 14 items | ~3 s |
| Local image 1.6 MB | ~4 s (sent as a data URL) |
| `capture` screenshot | ~1.5k tokens |

## Behaviour you should know about (Miro, not bugs)

- **Deleting a shape deletes its connectors.** `delete_items` reports them as `alreadyGone`.
- **Coordinates inside frames are relative.** You create items with board coordinates; reading them back gives coordinates relative to the frame's top-left. Tool descriptions tell the AI this.
- **Miro stops rendering a covered or minimized window.** Then adding to a frame fails with *"isn't inside a parent frame"* and `zoom_to` never finishes. On Windows the bridge brings the Miro window to the front without taking keyboard focus and retries once; elsewhere keep it on screen. A failed batch is rolled back, so nothing half-done is left.
- **Tables and pen drawings are opaque to the SDK.** They come back as `unsupported` / `curve` with only a bounding box; the AI reads them with `capture`. It cannot create native tables (it draws one with `create_table`) or pen strokes (it draws an SVG image).
- **Several board tabs:** the newest tab receives commands; closing it falls back to the previous one.
- **Rate limits:** the Web SDK has per-user, per-minute limits. Big batches are fine; thousands of single calls are not.

## Keeping it healthy

| Command | When |
|---|---|
| `miro-bridge-mcp check` | Anything feels off. Prints service state, login start, board, app version and board menu, each OK/FAIL, with the reason when board menu actions fail. |
| `miro-bridge-mcp setup` | After an update, or to repair. Safe to re-run: restarts an old service, re-registers, skips the install page if a board is already connected. |
| `miro-bridge-mcp config` | Adding another AI app. |
| `miro-bridge-mcp uninstall` | Removes the login service, stops it, unregisters from Claude Code. Then `npm rm -g miro-bridge-mcp`. |

**Updating:** `npm install -g github:sawaddee123/MiroBridgeMCP`, then `miro-bridge-mcp setup`, then reload open board tabs once. If you forget the reload, the AI is told the board runs an older app and asks you to reload.

**Logs:** the background service writes to `%TEMP%\mirobridgemcp.log` (macOS/Linux: `$TMPDIR/mirobridgemcp.log`). Each line is one event (board connected, app page loaded...).

## Troubleshooting by symptom

| Symptom | Cause → fix |
|---|---|
| "No Miro board connected" | Board closed, or the app isn't installed in *that board's* team. Open a board of the right team. Run `check`. |
| Connected only after F5 | The background service isn't running (it starts at login). Run `setup` once. |
| Board menu actions missing | Beta (Miro's experimental custom actions). `check` shows how many of the 3 registered and Miro's error. Use the app icon meanwhile. |
| `capture` fails | Windows only; the Miro window must not be minimized (it may be covered). |
| Brave never connects | Brave blocks localhost by default: Settings → Privacy → allow **Localhost access** for miro.com. |
| Safari | Not supported (blocks the local connection). Use Chrome, Edge or the Miro desktop app. |
| "port 7788 is used by another program" | Something else owns the port: set `MIRO_BRIDGE_PORT` (and the Miro app's App URL). |

## Using your own Miro app

The default install link uses the maintainer's Miro app. To host your own (same code, your control), see *Host your own Miro app* in the README and upload `assets/miro-icon-outline.svg` (toolbar, monochrome) and `assets/miro-icon-colored.svg` in the app's Display information.
