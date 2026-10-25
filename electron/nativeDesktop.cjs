/**
 * Native Windows 11 integration helper for the Interactive 3D Desktop back wall.
 *
 * Uses a persistent background PowerShell + compiled C# Win32 P/Invoke bridge to provide:
 * 1. Window capture exclusion (SetWindowDisplayAffinity + WDA_EXCLUDEFROMCAPTURE + WS_EX_LAYERED)
 *    so the 3D room window never captures itself recursively ("infinite mirror").
 * 2. Click-through hit-testing (WS_EX_TRANSPARENT) + hardware input injection (SendInput)
 *    for left/right/middle click, double-click, drag, mouse wheel, and keyboard events.
 * 3. Per-Monitor DPI-aware physical display enumeration and system cursor shape inspection.
 */
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const CSHARP_SOURCE = `
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class Win32DesktopBridge {
    public const int GWL_EXSTYLE = -20;
    public const long WS_EX_LAYERED = 0x00080000L;
    public const long WS_EX_TRANSPARENT = 0x00000020L;
    public const uint LWA_ALPHA = 0x00000002u;
    public const uint WDA_NONE = 0x00000000u;
    public const uint WDA_EXCLUDEFROMCAPTURE = 0x00000011u;

    public const uint INPUT_MOUSE = 0;
    public const uint INPUT_KEYBOARD = 1;

    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;
    public const uint MOUSEEVENTF_HWHEEL = 0x1000;

    public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
    public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
    public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetLayeredWindowAttributes(IntPtr hWnd, uint crKey, byte bAlpha, uint dwFlags);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetCursorPos(out POINT lpPoint);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern IntPtr WindowFromPoint(POINT Point);

    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool GetCursorInfo(ref CURSORINFO pci);

    [DllImport("user32.dll")]
    public static extern IntPtr LoadCursor(IntPtr hInstance, int lpCursorName);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct CURSORINFO {
        public int cbSize;
        public int flags;
        public IntPtr hCursor;
        public POINT ptScreenPos;
    }

    private static IntPtr lastTargetWindow = IntPtr.Zero;

    public static void Init() {
        try { SetProcessDPIAware(); } catch {}
    }

    public static bool ConfigureCaptureExclusion(long hwndVal, bool exclude) {
        if (hwndVal == 0) return false;
        IntPtr hwnd = new IntPtr(hwndVal);
        long exStyle = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64();
        if ((exStyle & WS_EX_LAYERED) == 0) {
            SetWindowLongPtr(hwnd, GWL_EXSTYLE, new IntPtr(exStyle | WS_EX_LAYERED));
            SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
        }
        // Note: SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) is invoked in-process by
        // Electron's BrowserWindow.setContentProtection(true); we also call it here as a fallback.
        SetWindowDisplayAffinity(hwnd, exclude ? WDA_EXCLUDEFROMCAPTURE : WDA_NONE);
        return true;
    }

    public static void SetClickThrough(IntPtr hwnd, bool transparent) {
        if (hwnd == IntPtr.Zero) return;
        long exStyle = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64();
        long nextStyle = transparent
            ? (exStyle | WS_EX_LAYERED | WS_EX_TRANSPARENT)
            : (exStyle & ~WS_EX_TRANSPARENT);
        if (nextStyle != exStyle) {
            SetWindowLongPtr(hwnd, GWL_EXSTYLE, new IntPtr(nextStyle));
        }
    }

    public static string GetSystemCursorKind() {
        CURSORINFO ci = new CURSORINFO();
        ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
        if (!GetCursorInfo(ref ci)) return "arrow";
        IntPtr h = ci.hCursor;
        if (h == LoadCursor(IntPtr.Zero, 32513)) return "ibeam";     // IDC_IBEAM
        if (h == LoadCursor(IntPtr.Zero, 32649)) return "hand";      // IDC_HAND
        if (h == LoadCursor(IntPtr.Zero, 32514)) return "wait";      // IDC_WAIT
        if (h == LoadCursor(IntPtr.Zero, 32644) ||
            h == LoadCursor(IntPtr.Zero, 32645) ||
            h == LoadCursor(IntPtr.Zero, 32642) ||
            h == LoadCursor(IntPtr.Zero, 32643)) return "resize";    // IDC_SIZE*
        return "arrow";
    }

    public static string PerformMouse(
        long hwndVal,
        string action,
        int x,
        int y,
        int endX,
        int endY,
        string button,
        int wheelDeltaX,
        int wheelDeltaY
    ) {
        IntPtr hwnd = new IntPtr(hwndVal);
        POINT savedPt = new POINT();
        bool hadSaved = GetCursorPos(out savedPt);
        try {
            SetClickThrough(hwnd, true);
            SetCursorPos(x, y);

            POINT pt = new POINT { X = x, Y = y };
            IntPtr hitWnd = WindowFromPoint(pt);
            if (hitWnd != IntPtr.Zero && hitWnd != hwnd) {
                IntPtr rootWnd = GetAncestor(hitWnd, 2); // GA_ROOT
                if (rootWnd != IntPtr.Zero && rootWnd != hwnd) {
                    lastTargetWindow = rootWnd;
                }
            }

            uint downFlag = button == "right" ? MOUSEEVENTF_RIGHTDOWN
                          : button == "middle" ? MOUSEEVENTF_MIDDLEDOWN
                          : MOUSEEVENTF_LEFTDOWN;
            uint upFlag = button == "right" ? MOUSEEVENTF_RIGHTUP
                        : button == "middle" ? MOUSEEVENTF_MIDDLEUP
                        : MOUSEEVENTF_LEFTUP;

            if (action == "click") {
                if (lastTargetWindow != IntPtr.Zero) {
                    SetForegroundWindow(lastTargetWindow);
                }
                mouse_event(downFlag, 0, 0, 0, UIntPtr.Zero);
                Thread.Sleep(6);
                mouse_event(upFlag, 0, 0, 0, UIntPtr.Zero);
                Thread.Sleep(4);
            } else if (action == "dblclick") {
                if (lastTargetWindow != IntPtr.Zero) {
                    SetForegroundWindow(lastTargetWindow);
                }
                mouse_event(downFlag, 0, 0, 0, UIntPtr.Zero);
                mouse_event(upFlag, 0, 0, 0, UIntPtr.Zero);
                Thread.Sleep(18);
                mouse_event(downFlag, 0, 0, 0, UIntPtr.Zero);
                mouse_event(upFlag, 0, 0, 0, UIntPtr.Zero);
                Thread.Sleep(6);
            } else if (action == "drag") {
                if (lastTargetWindow != IntPtr.Zero) {
                    SetForegroundWindow(lastTargetWindow);
                }
                mouse_event(downFlag, 0, 0, 0, UIntPtr.Zero);
                Thread.Sleep(10);
                int steps = 8;
                for (int i = 1; i <= steps; i++) {
                    int ix = x + ((endX - x) * i) / steps;
                    int iy = y + ((endY - y) * i) / steps;
                    SetCursorPos(ix, iy);
                    mouse_event(MOUSEEVENTF_MOVE, 0, 0, 0, UIntPtr.Zero);
                    Thread.Sleep(4);
                }
                mouse_event(upFlag, 0, 0, 0, UIntPtr.Zero);
                Thread.Sleep(6);
            } else if (action == "wheel") {
                if (wheelDeltaY != 0) {
                    mouse_event(MOUSEEVENTF_WHEEL, 0, 0, wheelDeltaY, UIntPtr.Zero);
                }
                if (wheelDeltaX != 0) {
                    mouse_event(MOUSEEVENTF_HWHEEL, 0, 0, wheelDeltaX, UIntPtr.Zero);
                }
                Thread.Sleep(3);
            }
        } finally {
            SetClickThrough(hwnd, false);
            if (hadSaved) {
                SetCursorPos(savedPt.X, savedPt.Y);
            }
        }
        return GetSystemCursorKind();
    }

    public static bool PerformKey(long hwndVal, string action, int vk, bool extended) {
        IntPtr hwnd = new IntPtr(hwndVal);
        IntPtr fg = GetForegroundWindow();
        if (fg == hwnd && lastTargetWindow != IntPtr.Zero) {
            SetForegroundWindow(lastTargetWindow);
            Thread.Sleep(2);
        }
        uint flags = extended ? KEYEVENTF_EXTENDEDKEY : 0u;
        if (action == "up") {
            flags |= KEYEVENTF_KEYUP;
        }
        keybd_event((byte)(vk & 0xFF), 0, flags, UIntPtr.Zero);
        return true;
    }
}
`;

const PS_BOOTSTRAP = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${CSHARP_SOURCE}
'@
[Win32DesktopBridge]::Init()
Write-Output '{"id":0,"ready":true}'
while ($null -ne ($line = [Console]::ReadLine())) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  try {
    $cmd = $line | ConvertFrom-Json
    $id = $cmd.id
    switch ($cmd.type) {
      'exclude' {
        $ok = [Win32DesktopBridge]::ConfigureCaptureExclusion([long]$cmd.hwnd, [bool]$cmd.exclude)
        Write-Output (ConvertTo-Json -Compress @{ id = $id; ok = $ok })
      }
      'mouse' {
        $cursor = [Win32DesktopBridge]::PerformMouse(
          [long]$cmd.hwnd,
          [string]$cmd.action,
          [int]$cmd.x,
          [int]$cmd.y,
          [int]$cmd.endX,
          [int]$cmd.endY,
          [string]$cmd.button,
          [int]$cmd.wheelDeltaX,
          [int]$cmd.wheelDeltaY
        )
        Write-Output (ConvertTo-Json -Compress @{ id = $id; ok = $true; cursor = $cursor })
      }
      'key' {
        $ok = [Win32DesktopBridge]::PerformKey(
          [long]$cmd.hwnd,
          [string]$cmd.action,
          [int]$cmd.vk,
          [bool]$cmd.extended
        )
        Write-Output (ConvertTo-Json -Compress @{ id = $id; ok = $ok })
      }
      'cursor' {
        $cursor = [Win32DesktopBridge]::GetSystemCursorKind()
        Write-Output (ConvertTo-Json -Compress @{ id = $id; ok = $true; cursor = $cursor })
      }
      default {
        Write-Output (ConvertTo-Json -Compress @{ id = $id; ok = $false; error = 'unknown_type' })
      }
    }
  } catch {
    Write-Output (ConvertTo-Json -Compress @{ id = 0; ok = $false; error = $_.Exception.Message })
  }
}
`;

class NativeDesktopHelper {
  constructor() {
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.readyPromise = null;
  }

  start() {
    if (this.readyPromise) return this.readyPromise;
    if (process.platform !== 'win32') {
      this.readyPromise = Promise.resolve(false);
      return this.readyPromise;
    }

    this.readyPromise = new Promise((resolve) => {
      try {
        this.proc = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
          {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          },
        );

        const rl = readline.createInterface({ input: this.proc.stdout });
        rl.on('line', (line) => {
          const trimmed = line.trim();
          if (!trimmed.startsWith('{')) return;
          try {
            const msg = JSON.parse(trimmed);
            if (msg.id === 0 && msg.ready) {
              resolve(true);
              return;
            }
            const handler = this.pending.get(msg.id);
            if (handler) {
              this.pending.delete(msg.id);
              handler(msg);
            }
          } catch {
            // Ignore malformed lines
          }
        });

        this.proc.on('exit', () => {
          this.proc = null;
          this.readyPromise = null;
          for (const [, handler] of this.pending) {
            handler({ ok: false, error: 'process_exited' });
          }
          this.pending.clear();
        });

        this.proc.stdin.write(PS_BOOTSTRAP + '\n');
      } catch {
        resolve(false);
      }
    });

    return this.readyPromise;
  }

  async send(payload) {
    const ready = await this.start();
    if (!ready || !this.proc || !this.proc.stdin.writable) {
      return { ok: false, error: 'bridge_unavailable' };
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve({ ok: false, error: 'timeout' });
        }
      }, 1500);

      this.pending.set(id, (res) => {
        clearTimeout(timer);
        resolve(res);
      });

      try {
        this.proc.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: String(err) });
      }
    });
  }

  async setCaptureExclusion(hwnd, exclude) {
    return this.send({ type: 'exclude', hwnd, exclude: Boolean(exclude) });
  }

  async sendMouse(hwnd, event) {
    return this.send({
      type: 'mouse',
      hwnd,
      action: event.action || 'click',
      x: Math.round(event.x || 0),
      y: Math.round(event.y || 0),
      endX: Math.round(event.endX ?? event.x ?? 0),
      endY: Math.round(event.endY ?? event.y ?? 0),
      button: event.button || 'left',
      wheelDeltaX: Math.round(event.wheelDeltaX || 0),
      wheelDeltaY: Math.round(event.wheelDeltaY || 0),
    });
  }

  async sendKey(hwnd, event) {
    return this.send({
      type: 'key',
      hwnd,
      action: event.action || 'down',
      vk: Number(event.vk || 0),
      extended: Boolean(event.extended),
    });
  }

  dispose() {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        // Ignore
      }
      this.proc = null;
    }
  }
}

function getWindowHwndNumber(win) {
  if (!win || win.isDestroyed()) return 0;
  try {
    const buf = win.getNativeWindowHandle();
    if (buf.length === 8) {
      return Number(buf.readBigInt64LE(0));
    }
    return buf.readInt32LE(0);
  } catch {
    return 0;
  }
}

module.exports = {
  NativeDesktopHelper,
  getWindowHwndNumber,
};
