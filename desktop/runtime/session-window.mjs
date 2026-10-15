import path from "node:path";
import { spawn } from "node:child_process";

export const SESSION_WINDOW_FOCUS_TIMEOUT_MS = 10_000;
export const SESSION_WINDOW_OUTCOMES = Object.freeze(["focused", "refused", "ambiguous", "missing", "unavailable"]);
const MAX_OUTPUT_BYTES = 64;
const PROCESS_START = /^\d{15,20}$/u;
const UNSAFE_TITLE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

// Reads the window list, the process tree, and which console or terminal processes hold a
// handle to the session's process; it sends no input and attaches to nothing. A window
// qualifies only when it belongs to that console or terminal, or to the session's nearest
// ancestor that owns windows. More than one candidate is ambiguous and nothing is focused,
// except that among the windows of a terminal that hosts the session, the one window whose
// title contains the session title is chosen.
const FOCUS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class PomegrSessionWindow {
  delegate bool EnumProc(IntPtr window, IntPtr parameter);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct ProcessEntry {
    public uint Size; public uint Usage; public uint Pid; public IntPtr Heap; public uint Module;
    public uint Threads; public uint ParentPid; public int Priority; public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string Executable;
  }
  [StructLayout(LayoutKind.Sequential)] struct HandleEntry {
    public IntPtr Object; public IntPtr Pid; public IntPtr Handle; public uint Access;
    public ushort Creator; public ushort Type; public uint Attributes; public uint Reserved;
  }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
  [DllImport("user32.dll")] static extern int GetWindowTextLengthW(IntPtr window);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr window, System.Text.StringBuilder text, int size);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int type, IntPtr buffer, int size, out int needed);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
  [DllImport("kernel32.dll")] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll")] static extern uint GetProcessId(IntPtr process);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
  const uint QUERY_LIMITED = 0x1000;
  const uint DUPLICATE = 0x40;
  const int EXTENDED_HANDLES = 64;
  const int MAX_HANDLE_BYTES = 256 << 20;
  const int MAX_DEPTH = 16;
  static readonly string[] Consoles = { "conhost.exe", "openconsole.exe" };
  static readonly string[] Terminals = { "windowsterminal.exe" };
  static readonly string[] Boundaries = { "explorer.exe", "svchost.exe", "services.exe", "wininit.exe", "winlogon.exe",
    "csrss.exe", "smss.exe", "sihost.exe", "dllhost.exe", "runtimebroker.exe", "userinit.exe" };
  static long Started(IntPtr process) {
    long created, exited, kernel, user;
    return GetProcessTimes(process, out created, out exited, out kernel, out user) ? created : -1;
  }
  static long Started(uint pid) {
    IntPtr process = OpenProcess(QUERY_LIMITED, false, pid);
    if (process == IntPtr.Zero) return -1;
    try { return Started(process); } finally { CloseHandle(process); }
  }
  static string Name(Dictionary<uint, ProcessEntry> processes, uint pid) {
    ProcessEntry entry; return processes.TryGetValue(pid, out entry) ? (entry.Executable ?? "").ToLowerInvariant() : "";
  }
  // The console and terminal processes that hold an open handle to this exact process.
  static HashSet<uint> Holders(uint pid, long start, HashSet<uint> hosts) {
    HashSet<uint> found = new HashSet<uint>();
    if (hosts.Count == 0) return found;
    uint self = GetCurrentProcessId();
    IntPtr own = OpenProcess(QUERY_LIMITED, false, self);
    if (own == IntPtr.Zero) return found;
    int size = 4 << 20; IntPtr buffer = IntPtr.Zero;
    Dictionary<uint, IntPtr> sources = new Dictionary<uint, IntPtr>();
    try {
      while (true) {
        buffer = Marshal.AllocHGlobal(size); int needed;
        int status = NtQuerySystemInformation(EXTENDED_HANDLES, buffer, size, out needed);
        if (status == 0) break;
        Marshal.FreeHGlobal(buffer); buffer = IntPtr.Zero;
        if (status != unchecked((int)0xC0000004) || size >= MAX_HANDLE_BYTES) return found;
        size = Math.Min(MAX_HANDLE_BYTES, Math.Max(size * 2, needed + (1 << 20)));
      }
      long count = Marshal.ReadIntPtr(buffer).ToInt64();
      int width = Marshal.SizeOf(typeof(HandleEntry));
      if (count < 0 || IntPtr.Size * 2 + count * width > size) return found;
      long first = buffer.ToInt64() + IntPtr.Size * 2;
      int processType = -1;
      for (long index = 0; index < count && processType < 0; index++) {
        HandleEntry entry = (HandleEntry)Marshal.PtrToStructure(new IntPtr(first + index * width), typeof(HandleEntry));
        if ((uint)entry.Pid.ToInt64() == self && entry.Handle == own) processType = entry.Type;
      }
      if (processType < 0) return found;
      for (long index = 0; index < count; index++) {
        HandleEntry entry = (HandleEntry)Marshal.PtrToStructure(new IntPtr(first + index * width), typeof(HandleEntry));
        uint holder = (uint)entry.Pid.ToInt64();
        if (entry.Type != processType || !hosts.Contains(holder) || found.Contains(holder)) continue;
        IntPtr source;
        if (!sources.TryGetValue(holder, out source)) { source = OpenProcess(DUPLICATE, false, holder); sources[holder] = source; }
        if (source == IntPtr.Zero) continue;
        IntPtr copy;
        if (!DuplicateHandle(source, entry.Handle, GetCurrentProcess(), out copy, QUERY_LIMITED, false, 0)) continue;
        try { if (GetProcessId(copy) == pid && Started(copy) == start) found.Add(holder); } finally { CloseHandle(copy); }
      }
      return found;
    } finally {
      foreach (IntPtr source in sources.Values) if (source != IntPtr.Zero) CloseHandle(source);
      if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
      CloseHandle(own);
    }
  }
  static bool Candidate(IntPtr window) {
    if (window == IntPtr.Zero || !IsWindowVisible(window) || GetWindow(window, 4) != IntPtr.Zero) return false;
    if ((GetWindowLongPtr(window, -20).ToInt64() & 0x80) != 0) return false;
    return GetWindowTextLengthW(window) > 0;
  }
  static List<IntPtr> WindowsOf(Dictionary<uint, List<IntPtr>> owned, IEnumerable<uint> pids) {
    List<IntPtr> windows = new List<IntPtr>(); List<IntPtr> list;
    foreach (uint pid in pids) if (owned.TryGetValue(pid, out list)) windows.AddRange(list);
    return windows;
  }
  // One terminal process can show many windows; only the one titled with this session may break the tie.
  static List<IntPtr> Titled(List<IntPtr> windows, string title) {
    List<IntPtr> matches = new List<IntPtr>();
    if (windows.Count < 2 || String.IsNullOrEmpty(title)) return windows;
    foreach (IntPtr window in windows) {
      System.Text.StringBuilder text = new System.Text.StringBuilder(512);
      GetWindowTextW(window, text, text.Capacity);
      if (text.ToString().IndexOf(title, StringComparison.Ordinal) >= 0) matches.Add(window);
    }
    return matches.Count == 1 ? matches : windows;
  }
  static string Focus(List<IntPtr> windows) {
    if (windows.Count > 1) return "ambiguous";
    IntPtr window = windows[0];
    if (IsIconic(window)) ShowWindow(window, 9);
    return SetForegroundWindow(window) ? "focused" : "refused";
  }
  public static string Run(uint pid, long start, uint self, string title) {
    if (pid == 0 || start <= 0 || Started(pid) != start) return "missing";
    Dictionary<uint, ProcessEntry> processes = new Dictionary<uint, ProcessEntry>();
    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1)) return "unavailable";
    try {
      ProcessEntry entry = new ProcessEntry(); entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
      for (bool more = Process32FirstW(snapshot, ref entry); more; more = Process32NextW(snapshot, ref entry)) processes[entry.Pid] = entry;
    } finally { CloseHandle(snapshot); }
    Dictionary<uint, List<IntPtr>> owned = new Dictionary<uint, List<IntPtr>>();
    EnumWindows(delegate (IntPtr window, IntPtr parameter) {
      uint owner; GetWindowThreadProcessId(window, out owner);
      if (Candidate(window)) { List<IntPtr> list; if (!owned.TryGetValue(owner, out list)) { list = new List<IntPtr>(); owned[owner] = list; } list.Add(window); }
      return true;
    }, IntPtr.Zero);
    HashSet<uint> hosts = new HashSet<uint>();
    foreach (uint candidate in processes.Keys) {
      string name = Name(processes, candidate);
      if (Array.IndexOf(Consoles, name) >= 0 || Array.IndexOf(Terminals, name) >= 0) hosts.Add(candidate);
    }
    List<uint> consoles = new List<uint>(); List<uint> terminals = new List<uint>();
    foreach (uint holder in Holders(pid, start, hosts)) (Array.IndexOf(Consoles, Name(processes, holder)) >= 0 ? consoles : terminals).Add(holder);
    // A classic console shows its own window; a terminal shows the console it hosts.
    List<IntPtr> windows = WindowsOf(owned, consoles);
    if (windows.Count == 0) windows = Titled(WindowsOf(owned, terminals), title);
    if (windows.Count > 0) return Focus(windows);
    uint current = pid; long currentStart = start;
    for (int depth = 0; depth < MAX_DEPTH; depth++) {
      if (current == 0 || current == 4 || current == self || !processes.ContainsKey(current)) return "missing";
      if (Array.IndexOf(Boundaries, Name(processes, current)) >= 0) return "missing";
      windows = WindowsOf(owned, new uint[] { current });
      if (windows.Count > 0) return Focus(windows);
      uint parent = processes[current].ParentPid;
      long parentStart = parent == 0 ? -1 : Started(parent);
      if (parentStart <= 0 || parentStart > currentStart) return "missing";
      current = parent; currentStart = parentStart;
    }
    return "missing";
  }
}
'@ | Out-Null
  [Console]::Out.Write([PomegrSessionWindow]::Run([uint32]$request.pid, [int64]$request.start, [uint32]$request.self, [string]$request.title))
} catch { [Console]::Out.Write('unavailable') }
`;

function powershellPath(environment) {
  return path.join(environment.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** The session title the helper may match a terminal window by, or "" when it is too short or unsafe. */
export function sessionWindowTitle(value) {
  if (typeof value !== "string") return "";
  const title = value.replace(/\s+/gu, " ").trim();
  return title.length >= 4 && title.length <= 96 && !UNSAFE_TITLE.test(title) ? title : "";
}

/** The helper's stdin request, or null: only a positive pid and a Windows process start time pass. */
export function sessionWindowFocusRequest(owner, selfPid, title = "") {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0 || owner.pid > 0x7fffffff
    || typeof owner.processStartIdentity !== "string" || !PROCESS_START.test(owner.processStartIdentity)
    || !Number.isInteger(selfPid) || selfPid <= 0 || selfPid > 0x7fffffff) return null;
  return { pid: owner.pid, start: owner.processStartIdentity, self: selfPid, title: sessionWindowTitle(title) };
}

/**
 * Focus the one window that shows a live session, from its monitor-observed owning process.
 * Resolves a fixed outcome; it never throws, and anything uncertain is not focused.
 */
export function focusSessionWindow(owner, options = {}) {
  if ((options.platform || process.platform) !== "win32") return Promise.resolve("unavailable");
  const request = sessionWindowFocusRequest(owner, options.selfPid ?? process.pid, options.title);
  if (!request) return Promise.resolve("missing");
  const spawnFn = options.spawnFn || spawn;
  const timeoutMs = Math.min(SESSION_WINDOW_FOCUS_TIMEOUT_MS, Math.max(1, options.timeoutMs || SESSION_WINDOW_FOCUS_TIMEOUT_MS));
  return new Promise((resolve) => {
    let child; let settled = false; let output = "";
    const stop = () => { try { child?.kill(); } catch { /* best effort */ } };
    const finish = (outcome = "unavailable") => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(outcome);
    };
    const timer = setTimeout(() => { stop(); finish(); }, timeoutMs);
    try {
      child = spawnFn(powershellPath(options.env || process.env), ["-NoProfile", "-NonInteractive", "-Command", FOCUS_SCRIPT], {
        windowsHide: true, shell: false, stdio: ["pipe", "pipe", "ignore"],
      });
      child.stdout?.on("data", (chunk) => {
        output += String(chunk);
        if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) { stop(); finish(); }
      });
      child.once?.("error", () => { stop(); finish(); });
      child.stdin?.once?.("error", stop);
      child.once?.("close", (code) => {
        const outcome = output.trim();
        finish(code === 0 && SESSION_WINDOW_OUTCOMES.includes(outcome) ? outcome : "unavailable");
      });
      child.stdin?.end(JSON.stringify(request));
    } catch { stop(); finish(); }
  });
}
