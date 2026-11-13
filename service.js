// Start the bridge at login as a hidden background service, so a board opened before any AI app
// still loads the Miro app (the app page is served by the bridge on localhost).
// Windows: a hidden .vbs in the Startup folder. macOS: a LaunchAgent. Linux: a systemd user unit.
// shortcut: macOS/Linux paths are untested on real machines; Windows is tested.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';

const NAME = 'MiroBridgeMCP';
const LABEL = 'com.mirobridgemcp.serve';

function target() {
  if (process.platform === 'win32') {
    return { kind: 'Windows Startup folder', file: join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${NAME}.vbs`) };
  }
  if (process.platform === 'darwin') return { kind: 'macOS LaunchAgent', file: join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`) };
  return { kind: 'systemd user service', file: join(homedir(), '.config', 'systemd', 'user', 'mirobridgemcp.service') };
}

export const autostartInstalled = () => existsSync(target().file);

/** Writes the login item. Returns a one-line description. Does not start it (the caller does, portably). */
export function installAutostart(node, server) {
  const { kind, file } = target();
  mkdirSync(dirname(file), { recursive: true });
  if (process.platform === 'win32') {
    const q = (s) => `""${s}""`; // VBScript escapes quotes by doubling
    writeFileSync(file, `' ${NAME}: keeps the Miro bridge running so boards load the app without a reload\r\n` +
      `CreateObject("WScript.Shell").Run "${q(node)} ${q(server)} serve", 0, False\r\n`);
  } else if (process.platform === 'darwin') {
    writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${server}</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
`);
  } else {
    writeFileSync(file, `[Unit]\nDescription=${NAME} bridge for Miro boards\n\n[Service]\nExecStart="${node}" "${server}" serve\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`);
    try { execSync('systemctl --user daemon-reload && systemctl --user enable mirobridgemcp.service', { stdio: 'ignore' }); } catch {}
  }
  return `${kind}: ${file}`;
}

export function removeAutostart() {
  const { file } = target();
  if (process.platform === 'linux') { try { execSync('systemctl --user disable mirobridgemcp.service', { stdio: 'ignore' }); } catch {} }
  if (process.platform === 'darwin') { try { execSync(`launchctl unload "${file}"`, { stdio: 'ignore' }); } catch {} }
  const had = existsSync(file);
  rmSync(file, { force: true });
  return had;
}
