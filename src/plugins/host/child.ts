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
import type { ToolContext, ToolResult } from '../../tools/types.ts';
import type { HookPayload } from '../../hooks/hooks.ts';
import type { HostAbort, HostOutbound, HostRequest, PluginDescriptor } from './rpc.ts';
import { encodeLine, parseLine } from './rpc.ts';

const NL = String.fromCharCode(10);

// ---- 1) 把 stdout 留给协议 ----
const toStderr = (...args: unknown[]) => {
  process.stderr.write(args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + NL);
};
for (const k of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
  (console as unknown as Record<string, unknown>)[k] = toStderr;
}
const emit = (msg: HostOutbound) => process.stdout.write(encodeLine(msg));

// ---- 2) 参数：工作区 + 要加载的插件目录 ----
function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const workspaceRoot = argOf('--workspace') ?? process.cwd();
const onlyDirs = process.argv.filter((x, i, arr) => arr[i - 1] === '--only' && !x.startsWith('-'));

const logger = new Logger('error');

/**
 * 子进程内的最小 ToolContext。
 *
 * 沙箱与审批**无法**跨进程沿用（子进程是独立 OS 进程），这里如实标为不限制，
 * 文档里也写明'进程隔离 ≠ 安全沙箱'。插件作者需要知道这个边界。
 */
function toolCtx(signal: AbortSignal): ToolContext {
  return {
    workspaceRoot,
    cwd: workspaceRoot,
    sandbox: { mode: 'danger-full-access', workspaceRoot },
    signal,
    logger,
    depth: 0,
  };
}

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
      inputSchema: t.inputSchema as unknown,
      isReadOnly: Boolean(t.isReadOnly),
      isDestructive: Boolean(t.isDestructive),
      concurrencySafe: true,
    })),
    routes: rt.routes.map((r) => ({ pluginId: rt.pluginId, method: r.method, path: r.path })),
    panels: rt.panels.map((p) => ({ id: p.id, title: p.title, icon: p.icon, slot: p.slot })),
    commands: rt.commands.map((c) => ({ pluginId: rt.pluginId, name: c.name, description: c.description })),
    hooks: rt.hooks.map((h) => ({ pluginId: rt.pluginId, event: String(h.event) })),
    skills: rt.skills.map((s) => ({ name: s.name, description: s.description, content: s.content })),
    promptSections: rt.promptSections,
  }));
}

async function boot(): Promise<void> {
  const loaded = await loadPlugins(workspaceRoot, logger, { onlyDirs, forceInProcess: true });
  runtimes = loaded.runtimes;
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
      const out: ToolResult = await tool.call(req.input ?? {}, toolCtx(controller.signal));
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
      const hits = rt?.hooks.filter((h) => String(h.event) === req.event) ?? [];
      let merged: Record<string, unknown> = {};
      for (const h of hits) {
        const out = await h.handler(req.payload as HookPayload);
        if (out && typeof out === 'object') merged = { ...merged, ...(out as Record<string, unknown>) };
      }
      emit({ id: req.id, ok: true, result: { result: merged } });
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
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  for (;;) {
    const nl = buffer.indexOf(NL);
    if (nl < 0) break;
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    const msg = parseLine(line);
    if (!msg || typeof msg !== 'object') continue;
    if ('type' in (msg as object) && (msg as { type?: string }).type === 'abort') {
      handleAbort(msg as HostAbort);
      continue;
    }
    if ('id' in (msg as object)) void handle(msg as HostRequest);
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
