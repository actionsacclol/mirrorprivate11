# Native dialogs of the tutorial instance only. Messages only: the real cursor and
# keyboard are never touched. list | close | click <button text>
param([string]$Action, [string]$Text = '')
$src = @'
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class D {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr par, EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  static string Name(IntPtr h) { var t = new StringBuilder(300); GetWindowText(h, t, 300); return t.ToString(); }
  static string Cls(IntPtr h) { var t = new StringBuilder(64); GetClassName(h, t, 64); return t.ToString(); }
  public static List<IntPtr> Dialogs(int pid) {
    var r = new List<IntPtr>();
    EnumWindows((h, l) => { int p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h) && Cls(h) == "#32770") r.Add(h); return true; }, IntPtr.Zero);
    return r;
  }
  public static string Describe(IntPtr d) {
    var parts = new List<string>();
    EnumChildWindows(d, (h, l) => { var n = Name(h); if (n.Length > 0) parts.Add(Cls(h) + ":" + n); return true; }, IntPtr.Zero);
    return Name(d) + " | " + string.Join(" ; ", parts);
  }
  public static void Close(IntPtr d) { PostMessage(d, 0x0010, IntPtr.Zero, IntPtr.Zero); }
  public static string Click(IntPtr d, string text) {
    string found = null;
    EnumChildWindows(d, (h, l) => { if (Cls(h) == "Button" && Name(h).Replace("&", "") == text) { PostMessage(h, 0x00F5, IntPtr.Zero, IntPtr.Zero); found = "clicked"; } return found == null; }, IntPtr.Zero);
    return found ?? "button-not-found";
  }
}
'@
Add-Type -TypeDefinition $src
$main = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -match 'profile=tutorial' -and $_.CommandLine -notmatch '--type=' }
foreach ($m in $main) {
  foreach ($d in [D]::Dialogs([int]$m.ProcessId)) {
    if ($Action -eq 'list') { [D]::Describe($d) }
    elseif ($Action -eq 'close') { [D]::Close($d); 'closed' }
    elseif ($Action -eq 'click') { [D]::Click($d, $Text) }
  }
}
