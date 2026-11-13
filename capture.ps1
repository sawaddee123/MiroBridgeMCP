# Screenshot of the browser window showing a Miro board (PrintWindow works even if the window is covered).
# shortcut: Windows only; picks the topmost visible Miro-app/browser window whose title contains "Miro".
param([string]$Out, [int]$MaxWidth = 1400, [string]$Title = 'Miro')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public struct RECT { public int L, T, R, B; }
}
'@
[W]::SetProcessDPIAware() | Out-Null # real pixel size on scaled displays
$script:hit = $null
$apps = 'Miro', 'chrome', 'brave', 'msedge', 'firefox', 'opera', 'vivaldi', 'arc' # a terminal titled "...Miro..." must not match
[W]::EnumWindows({ param($h, $l)
  $sb = New-Object System.Text.StringBuilder 512
  [W]::GetWindowText($h, $sb, 512) | Out-Null
  if (-not [W]::IsWindowVisible($h) -or $sb.ToString() -notlike "*$Title*") { return $true }
  $procId = 0; [W]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
  $proc = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
  if (-not ($apps -contains $proc) -or $sb.ToString() -like '*MiroBridgeMCP*') { return $true } # skip this project's own GitHub page
  if ($proc -eq 'Miro') { $script:hit = $h; $script:name = "$($sb.ToString()) [$proc]"; return $false } # desktop app wins
  if (-not $script:hit) { $script:hit = $h; $script:name = "$($sb.ToString()) [$proc]" } # else topmost browser tab
  return $true }, [IntPtr]::Zero) | Out-Null
if (-not $script:hit) { throw "No visible window with '$Title' in its title. Open the Miro board as the active tab." }
if ([W]::IsIconic($script:hit)) { throw "The Miro window is minimized. Restore it (it can stay behind other windows)." }
$r = New-Object W+RECT
[W]::GetWindowRect($script:hit, [ref]$r) | Out-Null
$w = $r.R - $r.L; $h = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
[W]::PrintWindow($script:hit, $dc, 2) | Out-Null # 2 = PW_RENDERFULLCONTENT, needed for Chromium
$g.ReleaseHdc($dc); $g.Dispose()
if ($w -gt $MaxWidth) { # downscale: fewer image tokens for Claude
  $s = New-Object System.Drawing.Bitmap $MaxWidth, ([int]($h * $MaxWidth / $w))
  $g2 = [System.Drawing.Graphics]::FromImage($s)
  $g2.InterpolationMode = 'HighQualityBicubic'
  $g2.DrawImage($bmp, 0, 0, $s.Width, $s.Height); $g2.Dispose(); $bmp.Dispose(); $bmp = $s
}
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "$($bmp.Width)x$($bmp.Height) $($script:name)"
