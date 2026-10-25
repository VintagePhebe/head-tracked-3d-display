// Launches Electron. On Windows, if invoked from a sandboxed non-Default desktop (such as an IDE
// agent runner's hidden exebox desktop) without --smoke, spawns Electron on Winsta0\Default so the
// GUI window opens visibly on the user's physical monitor.
import { spawn } from 'node:child_process';
import electronPath from 'electron';

const args = process.argv.slice(2);
const isSmoke = args.includes('--smoke');

if (process.platform === 'win32' && !isSmoke) {
  const exe = String(electronPath).replace(/'/g, "''");
  const cwd = process.cwd().replace(/'/g, "''");
  const extraArgs = args.join(' ').replace(/'/g, "''");
  const psScript = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinDesktopLauncher {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess, hThread;
    public int dwProcessId, dwThreadId;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CreateProcessW(
    string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes,
    IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags,
    IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo,
    out PROCESS_INFORMATION lpProcessInformation);
  [DllImport("kernel32.dll")]
  public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);
}
"@
$exe = '${exe}'
$si = New-Object WinDesktopLauncher+STARTUPINFO
$si.cb = [Runtime.InteropServices.Marshal]::SizeOf($si)
$si.lpDesktop = "Winsta0\\Default"
$pi = New-Object WinDesktopLauncher+PROCESS_INFORMATION
$cmd = New-Object System.Text.StringBuilder ("\`"" + $exe + "\`" . ${extraArgs}".Trim())
$ok = [WinDesktopLauncher]::CreateProcessW($exe, $cmd, [IntPtr]::Zero, [IntPtr]::Zero, $false, 0, [IntPtr]::Zero, '${cwd}', [ref]$si, [ref]$pi)
if (-not $ok) { exit 1 }
[WinDesktopLauncher]::WaitForSingleObject($pi.hProcess, 0xFFFFFFFF) | Out-Null
`;
  const child = spawn('powershell.exe', ['-NoProfile', '-Command', psScript], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  const child = spawn(String(electronPath), ['.', ...args], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}
