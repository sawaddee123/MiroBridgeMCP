"""Record the Miro window to an MP4 with PrintWindow (works for GPU-rendered windows, even when covered).

Usage: python scripts/record_window.py OUT.mp4 [--fps 20] [--title Miro] [--stop STOPFILE] [--max 300]
Stops when STOPFILE exists (or after --max seconds). Writes OUT.mp4 plus OUT.json with the real capture fps.
Windows only. Needs: numpy, ffmpeg (with libx264) on PATH.
"""
import argparse, ctypes, ctypes.wintypes as wt, json, os, subprocess, time
import numpy as np

user32, gdi32, kernel32 = ctypes.windll.user32, ctypes.windll.gdi32, ctypes.windll.kernel32
user32.SetProcessDPIAware()  # real pixels on scaled displays
# 64-bit handles: without explicit types ctypes truncates them to 32-bit ints
H = ctypes.c_void_p
user32.GetWindowDC.restype = H; user32.GetWindowDC.argtypes = [wt.HWND]
user32.ReleaseDC.argtypes = [wt.HWND, H]
user32.PrintWindow.argtypes = [wt.HWND, H, wt.UINT]
gdi32.CreateCompatibleDC.restype = H; gdi32.CreateCompatibleDC.argtypes = [H]
gdi32.CreateCompatibleBitmap.restype = H; gdi32.CreateCompatibleBitmap.argtypes = [H, ctypes.c_int, ctypes.c_int]
gdi32.SelectObject.restype = H; gdi32.SelectObject.argtypes = [H, H]
gdi32.GetDIBits.argtypes = [H, H, wt.UINT, wt.UINT, ctypes.c_void_p, ctypes.c_void_p, wt.UINT]
gdi32.DeleteObject.argtypes = [H]; gdi32.DeleteDC.argtypes = [H]
kernel32.OpenProcess.restype = H
kernel32.QueryFullProcessImageNameW.argtypes = [H, wt.DWORD, wt.LPWSTR, ctypes.POINTER(wt.DWORD)]
kernel32.CloseHandle.argtypes = [H]
APPS = {"miro.exe", "chrome.exe", "msedge.exe", "brave.exe", "firefox.exe"}  # never grab a terminal titled "...Miro..."


def find_window(title):
    found = []
    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        buf = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(hwnd, buf, 512)
        if title not in buf.value:
            return True
        pid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        h = kernel32.OpenProcess(0x1000, False, pid.value)  # PROCESS_QUERY_LIMITED_INFORMATION
        name = ctypes.create_unicode_buffer(260)
        size = wt.DWORD(260)
        kernel32.QueryFullProcessImageNameW(h, 0, name, ctypes.byref(size))
        kernel32.CloseHandle(h)
        proc = os.path.basename(name.value).lower()
        if proc in APPS and "MiroBridgeMCP" not in buf.value:  # skip e.g. this project's GitHub page in a browser
            found.append((proc != "miro.exe", hwnd))  # the Miro desktop app wins over browser tabs
        return True
    user32.EnumWindows(cb, 0)
    return min(found)[1] if found else None


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wt.DWORD), ("biWidth", wt.LONG), ("biHeight", wt.LONG), ("biPlanes", wt.WORD),
                ("biBitCount", wt.WORD), ("biCompression", wt.DWORD), ("biSizeImage", wt.DWORD),
                ("biXPelsPerMeter", wt.LONG), ("biYPelsPerMeter", wt.LONG), ("biClrUsed", wt.DWORD), ("biClrImportant", wt.DWORD)]


def grab(hwnd, w, h):
    hdc = user32.GetWindowDC(hwnd)
    mdc = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
    gdi32.SelectObject(mdc, bmp)
    user32.PrintWindow(hwnd, mdc, 2)  # PW_RENDERFULLCONTENT: needed for Chromium/Electron
    bi = BITMAPINFOHEADER(ctypes.sizeof(BITMAPINFOHEADER), w, -h, 1, 32, 0, 0, 0, 0, 0, 0)
    buf = np.empty((h, w, 4), np.uint8)
    gdi32.GetDIBits(mdc, bmp, 0, h, buf.ctypes.data, ctypes.byref(bi), 0)
    gdi32.DeleteObject(bmp); gdi32.DeleteDC(mdc); user32.ReleaseDC(hwnd, hdc)
    return buf[:, :, :3]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out"); ap.add_argument("--fps", type=float, default=20); ap.add_argument("--title", default="Miro")
    ap.add_argument("--stop"); ap.add_argument("--max", type=float, default=300)
    a = ap.parse_args()
    hwnd = find_window(a.title)
    if not hwnd:
        raise SystemExit(f"no visible Miro window (title contains {a.title!r})")
    r = wt.RECT(); user32.GetWindowRect(hwnd, ctypes.byref(r))
    w, h = (r.right - r.left) // 2 * 2, (r.bottom - r.top) // 2 * 2
    # H.264 at CRF 18 keeps screen text sharp; OpenCV's "mp4v" has no quality setting and came out blocky
    vw = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}",
                           "-r", str(a.fps), "-i", "-", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", a.out],
                          stdin=subprocess.PIPE)
    start, n, period = time.perf_counter(), 0, 1 / a.fps
    frame = grab(hwnd, w, h)
    while time.perf_counter() - start < a.max and not (a.stop and os.path.exists(a.stop)):
        due = start + n * period
        now = time.perf_counter()
        if now >= due:  # write one frame per slot; repeat the last grab if capture fell behind (keeps real time)
            vw.stdin.write(np.ascontiguousarray(frame).tobytes()); n += 1
            if now - due < period:
                frame = grab(hwnd, w, h)
        else:
            time.sleep(due - now)
    vw.stdin.close()
    if vw.wait():
        raise SystemExit(f"ffmpeg failed (exit {vw.returncode})")
    json.dump({"fps": a.fps, "frames": n, "seconds": round(time.perf_counter() - start, 2), "size": [w, h], "start_epoch": time.time() - (time.perf_counter() - start)},
              open(os.path.splitext(a.out)[0] + ".json", "w"))
    print(f"wrote {a.out}: {n} frames, {w}x{h}")


if __name__ == "__main__":
    main()
