/**
/**
 * 插件宿主子进程（对应 DSH cordis-host-runner 的 host 半）。
 *
 * 职责：在这个**独立进程**里加载插件、执行它们的工具/路由/命令/hook，
 * 通过 stdio 上的 JSON 行协议与父进程通信。
 *
 * 三条铁律：
 *   1. **stdout 只许走协议**。插件里的 console.log 会污染通道，所以进进程第一件事
 *      就是把 console 全部重定向到 stderr（父进程照常转发成日志）。
 *   2. 任何异常都必须变成一条 ok:false 响应，否则父进程会永久等待。
 *   3. 只上报**可序列化**的东西；函数一律留在本进程，调用时再求值。
 */
import { loadPlugins } from '../loader.ts';
import { Logger } from '../../util/log.ts';
import type { ToolResult } from '../../tools/types.ts';
import type { HookPayload } from '../../hooks/hooks.ts';
import type { HostAbort, HostOutbound, HostRequest, PluginDescriptor } from './rpc.ts';
import { encodeLine, parseLine, MAX_HOST_FRAME_BYTES, MAX_HOST_QUEUED_BYTES } from './rpc.ts';

const NL = String.fromCharCode(10);

// ---- 1) 把 stdout 留给协议 ----
const toStderr = (...args: unknown[]) => {
  process.stderr.write(args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + NL);
};
for (const k of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
  (console as unknown as Record<string, unknown>)[k] = toStderr;
}
// 插件不仅可能调用 console.log，也可能直接调用 process.stdout.write。
// 协议使用原始 write 函数，插件写入则降级到 stderr，避免一个字节就破坏当前帧。
const protocolWrite = process.stdout.write.bind(process.stdout);
(process.stdout as unknown as { write: (...args: any[]) => boolean }).write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
  const value = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
  toStderr(value);
  const done = typeof encoding === 'function' ? encoding : callback;
  if (typeof done === 'function') (done as () => void)();
  return true;
}) as typeof process.stdout.write;

let outboundBytes = 0;
const emit = (msg: HostOutbound) => {
  const line = encodeLine(msg);
  const bytes = Buffer.byteLength(line, "utf8");
  if (outboundBytes + bytes > MAX_HOST_QUEUED_BYTES) {
    toStderr("plugin host outbound queue exceeded", MAX_HOST_QUEUED_BYTES);
    process.exit(70);
    return;
  }
  outboundBytes += bytes;
  protocolWrite(line, (err?: Error | null) => {
    outboundBytes = Math.max(0, outboundBytes - bytes);
    if (err) process.exit(70);
  });
};

// ---- 2) 参数：工作区 + 要加载的插件目录 ----
function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const workspaceRoot = argOf('--workspace') ?? process.cwd();
const onlyDirs = process.argv.filter((x, i, arr) => arr[i - 1] === '--only' && !x.startsWith('-'));

const logger = new Logger('error');

/**
 * 进行中的调用 → 它们的 AbortController。
 * 收到父进程的 abort 消息时按 id 找到并停掉，插件通过 signal 感知后可以提前返回。
 */
const inflight = new Map<number, AbortController>();

/** 单次调用的安全上限：即使父进程失联（崩溃/被杀），子进程也不会永远挂着。 */
function safetyTimer(ms: number, controller: AbortController): NodeJS.Timeout {
  const t = setTimeout(() => controller.abort(new Error('调用超过宿主安全上限')), ms);
  (t as unknown as { unref?: () => void }).unref?.();
  return t;
}

// ---- 3) 加载 ----
type Runtimes = Awaited<ReturnType<typeof loadPlugins>>['runtimes'];
let runtimes: Runtimes = [];

function describe(dir: string): PluginDescriptor[] {
  return runtimes.map((rt) => ({
    pluginId: rt.pluginId,
    dir,
    tools: rt.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      isReadOnly: Boolean(t.isReadOnly),
      isDestructive: Boolean(t.isDestructive),
      retries: t.retries,
      maxOutputChars: t.maxOutputChars,
      timeoutMs: t.timeoutMs,
    })),
    routes: rt.routes.map((r) => ({ pluginId: rt.pluginId, method: r.method, path: r.path })),
    panels: rt.panels,
    commands: rt.commands.map((c) => ({ pluginId: rt.pluginId, name: c.name, description: c.description })),
    hooks: rt.hooks.map((h, index) => ({ pluginId: rt.pluginId, event: h.event, index })),
    skills: rt.skills.map((s) => ({ name: s.name, description: s.description, content: s.content })),
    promptSections: rt.promptSections,
  }));
}

async function boot(): Promise<void> {
  const loaded = await loadPlugins(workspaceRoot, logger, { onlyDirs, forceInProcess: true });
  runtimes = loaded.runtimes;
  for (const runtime of runtimes) {
    runtime.tools = runtime.tools.filter((tool) => {
      if (!tool.toolCheck) return true;
      loaded.warnings.push({ plugin: runtime.pluginId, message: tool.name + ': custom toolCheck requires in-process permission evaluation; tool unavailable in process isolation' });
      return false;
    });
  }
  emit({
    type: 'ready',
    plugins: describe(onlyDirs[0] ?? workspaceRoot),
    errors: loaded.errors,
    warnings: loaded.warnings,
  });
}

// ---- 4) 请求处理 ----
async function handle(req: HostRequest): Promise<void> {
  // 每次调用一个可取消的 controller：父进程超时/中止时会按 id 停掉它
  const controller = new AbortController();
  const timer = safetyTimer(10 * 60_000, controller);
  inflight.set(req.id, controller);
  try {
    if (req.method === 'tool.call') {
      const owner = runtimes.find((rt) => rt.tools.some((t) => t.name === req.toolName));
      const tool = owner?.tools.find((t) => t.name === req.toolName);
      if (!tool) throw new Error('unknown tool: ' + String(req.toolName));
      if (!req.context) throw new Error('missing tool context');
      const input = req.input ?? {};
      const invalid = tool.validate?.(input);
      if (invalid) throw new Error(invalid);
      const out: ToolResult = await tool.call(input, { ...req.context, signal: controller.signal, logger });
      emit({ id: req.id, ok: true, result: { content: out.content, isError: Boolean(out.isError), metadata: out.metadata } });
      return;
    }
    if (req.method === 'route') {
      const rt = runtimes.find((r) => r.pluginId === req.pluginId);
      const hit = rt?.routes.find((r) => r.method === req.httpMethod && r.path === req.path);
      if (!hit) throw new Error('unknown route: ' + String(req.httpMethod) + ' /' + String(req.path));
      const out = await hit.handler({
        pluginId: req.pluginId ?? '',
        method: req.httpMethod ?? 'GET',
        path: req.path ?? '',
        query: req.query ?? {},
        body: req.body,
        workspaceRoot: req.workspaceRoot ?? workspaceRoot,
        // 路由也能感知取消（超时/客户端断开时父进程会发 abort）
        signal: controller.signal,
      });
      emit({ id: req.id, ok: true, result: { status: out?.status ?? 200, json: out?.json, text: out?.text } });
      return;
    }
    if (req.method === 'command') {
      const rt = runtimes.find((r) => r.pluginId === req.pluginId);
      const wanted = req.commandName ?? '';
      const hit = rt?.commands.find((c) => c.name === wanted || '/' + c.name === wanted || c.name === '/' + wanted);
      if (!hit) throw new Error('unknown command: ' + wanted);
      const out = await hit.run(req.arg ?? '', { workspaceRoot: req.workspaceRoot ?? workspaceRoot, signal: controller.signal });
      emit({ id: req.id, ok: true, result: { output: typeof out === 'string' ? out : String(out) } });
      return;
    }
    if (req.method === 'hook') {
      const rt = runtimes.find((r) => r.pluginId === req.pluginId);
      const hook = req.hookIndex === undefined ? undefined : rt?.hooks[req.hookIndex];
      if (!hook || hook.event !== req.event) throw new Error('unknown hook: ' + String(req.event));
      const result = await hook.handler(req.payload as HookPayload);
      emit({ id: req.id, ok: true, result: { result: result ?? {} } });
      return;
    }
    throw new Error('unknown method: ' + String(req.method));
  } catch (err) {
    emit({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  } finally {
    clearTimeout(timer);
    inflight.delete(req.id);
  }
}

/** 父进程发来的取消：按 id 停掉对应调用。 */
function handleAbort(msg: HostAbort): void {
  const controller = inflight.get(msg.id);
  if (!controller) return;
  controller.abort(new Error(msg.reason ?? '父进程取消了这次调用'));
}

// ---- 5) 入口 ----
process.on('uncaughtException', (err) => {
  toStderr('plugin host uncaught:', err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(70);
});
process.on('unhandledRejection', (err) => {
  toStderr('plugin host unhandled rejection:', err instanceof Error ? err.message : String(err));
});

process.stdin.setEncoding('utf8');
let buffer = '';
let bufferBytes = 0;
let parentDisconnected = false;
const onParentDisconnected = () => {
  if (parentDisconnected) return;
  parentDisconnected = true;
  for (const controller of inflight.values()) controller.abort(new Error('父进程已断开'));
  // 父进程崩溃/SIGKILL 不会运行它的 exit handler；stdin EOF 是子进程唯一可靠信号。
  // 立即退出以清理插件遗留的 interval/server/句柄，避免宿主成为孤儿。
  process.exit(0);
};
process.stdin.on('end', onParentDisconnected);
process.stdin.on('close', onParentDisconnected);
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  bufferBytes += Buffer.byteLength(chunk, 'utf8');
  for (;;) {
    const nl = buffer.indexOf(NL);
    if (nl < 0) break;
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    const frameBytes = Buffer.byteLength(line, 'utf8') + 1;
    bufferBytes = Math.max(0, bufferBytes - frameBytes);
    if (frameBytes > MAX_HOST_FRAME_BYTES) {
      toStderr('plugin host inbound frame exceeds limit', frameBytes);
      process.exit(70);
      return;
    }
    const msg = parseLine(line);
    if (!msg || typeof msg !== 'object') continue;
    if ('type' in (msg as object) && (msg as { type?: string }).type === 'abort') {
      handleAbort(msg as HostAbort);
      continue;
    }
    if ('id' in (msg as object)) void handle(msg as HostRequest);
  }
  if (bufferBytes > MAX_HOST_FRAME_BYTES) {
    toStderr('plugin host unterminated input frame exceeds limit', bufferBytes);
    process.exit(70);
  }
});

void boot().catch((err) => {
  emit({
    type: 'ready',
    plugins: [],
    errors: [{ plugin: '<host>', message: err instanceof Error ? err.message : String(err) }],
    warnings: [],
  });
});
