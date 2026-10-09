const koffi = require('koffi');

// Only this process holds the job handle. Windows closes it on a crash as well.
// The Ollama process is assigned before its first instruction can spawn a runner.
export class WindowsJob {
  private job: unknown;
  private processHandle: unknown;
  readonly pid: number;
  private static api: any;
  private static getApi(): any {
    if (this.api) return this.api;
    const lib = koffi.load('kernel32.dll');
    const basic = koffi.struct('MYMIND_BASIC_LIMIT', { PerProcessUserTimeLimit: 'int64', PerJobUserTimeLimit: 'int64', LimitFlags: 'uint32', MinimumWorkingSetSize: 'size_t', MaximumWorkingSetSize: 'size_t', ActiveProcessLimit: 'uint32', Affinity: 'uintptr_t', PriorityClass: 'uint32', SchedulingClass: 'uint32' });
    const io = koffi.struct('MYMIND_IO_COUNTERS', { ReadOperationCount: 'uint64', WriteOperationCount: 'uint64', OtherOperationCount: 'uint64', ReadTransferCount: 'uint64', WriteTransferCount: 'uint64', OtherTransferCount: 'uint64' });
    const limits = koffi.struct('MYMIND_EXTENDED_LIMIT', { BasicLimitInformation: basic, IoInfo: io, ProcessMemoryLimit: 'size_t', JobMemoryLimit: 'size_t', PeakProcessMemoryUsed: 'size_t', PeakJobMemoryUsed: 'size_t' });
    const startup = koffi.struct('MYMIND_STARTUPINFO', { cb: 'uint32', lpReserved: 'void *', lpDesktop: 'void *', lpTitle: 'void *', dwX: 'uint32', dwY: 'uint32', dwXSize: 'uint32', dwYSize: 'uint32', dwXCountChars: 'uint32', dwYCountChars: 'uint32', dwFillAttribute: 'uint32', dwFlags: 'uint32', wShowWindow: 'uint16', cbReserved2: 'uint16', lpReserved2: 'void *', hStdInput: 'void *', hStdOutput: 'void *', hStdError: 'void *' });
    const info = koffi.struct('MYMIND_PROCESSINFO', { hProcess: 'void *', hThread: 'void *', dwProcessId: 'uint32', dwThreadId: 'uint32' });
    return this.api = {
      limits, startup,
      createJob: lib.func('void * __stdcall CreateJobObjectW(void *attributes, str16 name)'),
      setLimits: lib.func('int __stdcall SetInformationJobObject(void *job, int cls, MYMIND_EXTENDED_LIMIT *limits, uint32 length)'),
      createProcess: lib.func('int __stdcall CreateProcessW(str16 app, void *command, void *processAttributes, void *threadAttributes, int inherit, uint32 flags, void *environment, str16 cwd, MYMIND_STARTUPINFO *startup, _Out_ MYMIND_PROCESSINFO *info)'),
      assign: lib.func('int __stdcall AssignProcessToJobObject(void *job, void *process)'),
      resume: lib.func('uint32 __stdcall ResumeThread(void *thread)'),
      terminateProcess: lib.func('int __stdcall TerminateProcess(void *process, uint32 code)'),
      terminateJob: lib.func('int __stdcall TerminateJobObject(void *job, uint32 code)'),
      wait: lib.func('uint32 __stdcall WaitForSingleObject(void *handle, uint32 milliseconds)'),
      close: lib.func('int __stdcall CloseHandle(void *handle)'),
      error: lib.func('uint32 __stdcall GetLastError()')
    };
  }
  constructor(executable: string, environment: NodeJS.ProcessEnv, args: string[] = ['serve'], label = 'Ollama') {
    const api = WindowsJob.getApi();
    this.job = api.createJob(null, null);
    if (!this.job) throw new Error(`Could not create the ${label} process group (Windows ${api.error()}).`);
    const limits = Buffer.alloc(koffi.sizeof(api.limits));
    koffi.encode(limits, api.limits, { BasicLimitInformation: { LimitFlags: 0x2000 } });
    if (!api.setLimits(this.job, 9, limits, limits.length)) { const code = api.error(); this.close(); throw new Error(`Could not configure process cleanup (Windows ${code}).`); }
    const env = Buffer.from(Object.entries(environment).filter((entry): entry is [string,string] => typeof entry[1] === 'string').sort(([a],[b]) => a.localeCompare(b)).map(([key,value]) => `${key}=${value}`).join('\0') + '\0\0', 'utf16le');
    const quote = (value: string) => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
    const command = Buffer.from([executable,...args].map(quote).join(' ') + '\0', 'utf16le');
    const startup = Buffer.alloc(koffi.sizeof(api.startup));
    koffi.encode(startup, api.startup, { cb: startup.length });
    const info: any = {};
    // CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW.
    if (!api.createProcess(executable, command, null, null, 0, 0x08000404, env, null, startup, info)) { const code = api.error(); this.close(); throw new Error(`Could not start ${label} (Windows ${code}).`); }
    this.processHandle = info.hProcess; this.pid = info.dwProcessId;
    if (!api.assign(this.job, info.hProcess)) { const code = api.error(); api.terminateProcess(info.hProcess, 1); api.close(info.hThread); this.close(); throw new Error(`Could not attach ${label} to its cleanup group (Windows ${code}).`); }
    const resumed = api.resume(info.hThread); api.close(info.hThread);
    if (resumed === 0xffffffff) { this.close(); throw new Error('Could not resume Ollama.'); }
  }
  get alive(): boolean { return !!this.processHandle && WindowsJob.getApi().wait(this.processHandle, 0) === 258; }
  close(): void {
    const api = WindowsJob.getApi();
    if (this.job) { api.terminateJob(this.job, 0); api.close(this.job); this.job = null; }
    if (this.processHandle) { api.close(this.processHandle); this.processHandle = null; }
  }
}
