// jys-sandbox: Windows OS-level sandbox launcher for JYSHarness.
//
// AppContainer  = 文件系统/网络边界（内核强制，ACE 授权之外一律拒绝）
// Job Object    = 资源边界（内存、进程数、随父进程终止）
//
// 编译：csc.exe /nologo /optimize+ /target:exe /out:jys-sandbox.exe jys-sandbox.cs
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

[StructLayout(LayoutKind.Sequential)]
struct IO_COUNTERS {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
}

[StructLayout(LayoutKind.Sequential)]
struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
}

[StructLayout(LayoutKind.Sequential)]
struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
}

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput, hStdOutput, hStdError;
}

[StructLayout(LayoutKind.Sequential)]
struct STARTUPINFOEX {
    public STARTUPINFO StartupInfo;
    public IntPtr lpAttributeList;
}

[StructLayout(LayoutKind.Sequential)]
struct SECURITY_CAPABILITIES {
    public IntPtr AppContainerSid;
    public IntPtr Capabilities;
    public uint CapabilityCount;
    public uint Reserved;
}

[StructLayout(LayoutKind.Sequential)]
struct PROCESS_INFORMATION {
    public IntPtr hProcess, hThread;
    public int dwProcessId, dwThreadId;
}

static class Native {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr info, uint len);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcess(string app, StringBuilder cmdLine, IntPtr pa, IntPtr ta,
        bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr handle, uint ms);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeProcess(IntPtr process, out uint code);

    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr h);

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetStdHandle(int n);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr ret);

    [DllImport("kernel32.dll")]
    public static extern void DeleteProcThreadAttributeList(IntPtr list);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    public static extern int CreateAppContainerProfile(string name, string displayName, string description, IntPtr caps, uint capCount, out IntPtr sid);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    public static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr str);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool ConvertStringSidToSid(string str, out IntPtr sid);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool SetTokenInformation(IntPtr token, int infoClass, IntPtr info, uint len);

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();

    [DllImport("advapi32.dll")]
    public static extern IntPtr FreeSid(IntPtr sid);

    [DllImport("kernel32.dll")]
    public static extern IntPtr LocalFree(IntPtr h);
}

static class Program {
    const uint JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100;
    const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200;
    const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const int JobObjectExtendedLimitInformation = 9;
    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    const int STARTF_USESTDHANDLES = 0x00000100;
    const uint INFINITE = 0xFFFFFFFF;

    static int Main(string[] args) {
        int memoryMb = 0;
        int maxProcs = 0;
        string container = null;
        string cwd = null;
        bool printSid = false;
        bool lowIntegrity = false;
        List<string> cmd = new List<string>();

        for (int i = 0; i < args.Length; i++) {
            string a = args[i];
            if (a == "--") { for (int j = i + 1; j < args.Length; j++) cmd.Add(args[j]); break; }
            else if (a == "--memory") memoryMb = int.Parse(args[++i]);
            else if (a == "--procs") maxProcs = int.Parse(args[++i]);
            else if (a == "--container") container = args[++i];
            else if (a == "--cwd") cwd = args[++i];
            else if (a == "--print-sid") printSid = true;
            else if (a == "--low-integrity") lowIntegrity = true;
            else { Console.Error.WriteLine("jys-sandbox: unknown option " + a); return 2; }
        }

        if (container != null) {
            IntPtr sid;
            int rc = Native.CreateAppContainerProfile(container, container, "JYSHarness sandbox", IntPtr.Zero, 0, out sid);
            // ERROR_ALREADY_EXISTS (183) is fine: derive the existing SID instead.
            if (rc != 0) {
                if (Native.DeriveAppContainerSidFromAppContainerName(container, out sid) != 0) {
                    Console.Error.WriteLine("jys-sandbox: AppContainer unavailable (0x" + rc.ToString("X8") + ")");
                    return 3;
                }
            }
            IntPtr str;
            Native.ConvertSidToStringSid(sid, out str);
            string sidStr = Marshal.PtrToStringUni(str);
            Native.LocalFree(str);
            if (printSid) { Console.Out.WriteLine(sidStr); return 0; }
            if (cmd.Count == 0) return 0;
            return RunInContainer(cmd, cwd, sid, memoryMb, maxProcs);
        }

        if (printSid) return 0;
        if (cmd.Count == 0) { Console.Error.WriteLine("jys-sandbox: no command"); return 2; }
        if (lowIntegrity) {
            int lowered = LowerIntegrity();
            if (lowered != 0) return lowered;
        }
        return RunPlain(cmd, cwd, memoryMb, maxProcs);
    }

    /// <summary>
    /// Drop this process to Low integrity. Lowering your own token needs no
    /// privilege, and every child inherits it: reads still work everywhere,
    /// writes are then limited by the kernel to Low-integrity objects.
    /// </summary>
    static int LowerIntegrity() {
        IntPtr sid;
        if (!Native.ConvertStringSidToSid("S-1-16-4096", out sid)) {
            Console.Error.WriteLine("jys-sandbox: bad integrity SID");
            return 4;
        }
        // TOKEN_MANDATORY_LABEL { SID_AND_ATTRIBUTES Label; }
        IntPtr label = Marshal.AllocHGlobal(IntPtr.Size + 8);
        Marshal.WriteIntPtr(label, 0, sid);
        Marshal.WriteInt32(label, IntPtr.Size, 0x00000020); // SE_GROUP_INTEGRITY
        IntPtr token;
        if (!Native.OpenProcessToken(Native.GetCurrentProcess(), 0xF01FF, out token)) {
            Console.Error.WriteLine("jys-sandbox: OpenProcessToken failed (" + Marshal.GetLastWin32Error() + ")");
            return 4;
        }
        bool ok = Native.SetTokenInformation(token, 25 /* TokenIntegrityLevel */, label, (uint)(IntPtr.Size + 8));
        Native.CloseHandle(token);
        Marshal.FreeHGlobal(label);
        if (!ok) {
            Console.Error.WriteLine("jys-sandbox: cannot lower integrity (" + Marshal.GetLastWin32Error() + ")");
            return 4;
        }
        return 0;
    }

    static int RunPlain(List<string> cmd, string cwd, int memoryMb, int maxProcs) {
        STARTUPINFOEX si = MakeStartupInfo();
        PROCESS_INFORMATION pi;
        IntPtr job = CreateLimitedJob(memoryMb, maxProcs);
        StringBuilder line = Quote(cmd);
        if (!Native.CreateProcess(null, line, IntPtr.Zero, IntPtr.Zero, true, EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, cwd, ref si, out pi)) {
            Console.Error.WriteLine("jys-sandbox: CreateProcess failed (" + Marshal.GetLastWin32Error() + ")");
            return 1;
        }
        if (job != IntPtr.Zero) Native.AssignProcessToJobObject(job, pi.hProcess);
        return Wait(pi);
    }

    static int RunInContainer(List<string> cmd, string cwd, IntPtr appContainerSid, int memoryMb, int maxProcs) {
        STARTUPINFOEX si = MakeStartupInfo();
        int size = IntPtr.Size == 8 ? 48 : 28;
        IntPtr attrSize = IntPtr.Zero;
        Native.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrSize);
        IntPtr attrList = Marshal.AllocHGlobal(attrSize);
        if (!Native.InitializeProcThreadAttributeList(attrList, 1, 0, ref attrSize)) {
            Console.Error.WriteLine("jys-sandbox: InitializeProcThreadAttributeList failed");
            return 1;
        }
        SECURITY_CAPABILITIES caps = new SECURITY_CAPABILITIES();
        caps.AppContainerSid = appContainerSid;
        caps.Capabilities = IntPtr.Zero;
        caps.CapabilityCount = 0;
        caps.Reserved = 0;
        IntPtr capsPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
        Marshal.StructureToPtr(caps, capsPtr, false);
        // PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009
        IntPtr attr = (IntPtr)0x00020009;
        if (!Native.UpdateProcThreadAttribute(attrList, 0, attr, capsPtr, (IntPtr)Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)), IntPtr.Zero, IntPtr.Zero)) {
            Console.Error.WriteLine("jys-sandbox: UpdateProcThreadAttribute failed (" + Marshal.GetLastWin32Error() + ")");
            return 1;
        }
        si.lpAttributeList = attrList;

        PROCESS_INFORMATION pi;
        IntPtr job = CreateLimitedJob(memoryMb, maxProcs);
        StringBuilder line = Quote(cmd);
        bool ok = Native.CreateProcess(null, line, IntPtr.Zero, IntPtr.Zero, true,
            EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, cwd, ref si, out pi);
        if (!ok) {
            Console.Error.WriteLine("jys-sandbox: CreateProcess(AppContainer) failed (" + Marshal.GetLastWin32Error() + ")");
            return 1;
        }
        if (job != IntPtr.Zero) Native.AssignProcessToJobObject(job, pi.hProcess);
        return Wait(pi);
    }

    static STARTUPINFOEX MakeStartupInfo() {
        STARTUPINFOEX si = new STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = Native.GetStdHandle(-10);
        si.StartupInfo.hStdOutput = Native.GetStdHandle(-11);
        si.StartupInfo.hStdError = Native.GetStdHandle(-12);
        return si;
    }

    static IntPtr CreateLimitedJob(int memoryMb, int maxProcs) {
        if (memoryMb <= 0 && maxProcs <= 0) return IntPtr.Zero;
        IntPtr job = Native.CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        uint flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (memoryMb > 0) {
            flags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY;
            info.ProcessMemoryLimit = (UIntPtr)((ulong)memoryMb * 1024UL * 1024UL);
            info.JobMemoryLimit = (UIntPtr)((ulong)memoryMb * 1024UL * 1024UL);
        }
        if (maxProcs > 0) {
            flags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            info.BasicLimitInformation.ActiveProcessLimit = (uint)maxProcs;
        }
        info.BasicLimitInformation.LimitFlags = flags;
        int len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr ptr = Marshal.AllocHGlobal(len);
        Marshal.StructureToPtr(info, ptr, false);
        bool ok = Native.SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, (uint)len);
        Marshal.FreeHGlobal(ptr);
        if (!ok) { Console.Error.WriteLine("jys-sandbox: SetInformationJobObject failed"); return IntPtr.Zero; }
        return job;
    }

    static int Wait(PROCESS_INFORMATION pi) {
        Native.WaitForSingleObject(pi.hProcess, INFINITE);
        uint code;
        Native.GetExitCodeProcess(pi.hProcess, out code);
        Native.CloseHandle(pi.hThread);
        Native.CloseHandle(pi.hProcess);
        return (int)code;
    }

    static StringBuilder Quote(List<string> cmd) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < cmd.Count; i++) {
            if (i > 0) sb.Append(' ');
            string s = cmd[i];
            if (s.Length > 0 && s.IndexOf(' ') < 0 && s.IndexOf('"') < 0) { sb.Append(s); continue; }
            sb.Append('"');
            int bs = 0;
            foreach (char c in s) {
                if (c == '\\') { bs++; continue; }
                if (c == '"') { sb.Append(new string('\\', bs * 2 + 1)); sb.Append('"'); bs = 0; continue; }
                if (bs > 0) { sb.Append(new string('\\', bs)); bs = 0; }
                sb.Append(c);
            }
            if (bs > 0) sb.Append(new string('\\', bs * 2));
            sb.Append('"');
        }
        return sb;
    }
}
