import { formatCommandResult, runCommand, shellForPlatform } from "../sandbox/commands.ts";
import { classifyCommand } from "../permissions/classify.ts";
import { bool, num, str, type Tool } from "./types.ts";

const shellInfo = shellForPlatform();

/** 命令"首词"是纯读取类时才拦截；管道尾部的 Select-Object 之类不会误伤。 */
const SHELL_FILE_READ = /^[ 	]*(cat|type|more|head|tail|wc|nl|findstr|select-string|get-content|gc|ls|dir|get-childitem|tree)(?![a-z])/i;

const READONLY_SHELL_HEADS = new Set([
  "get-childitem", "get-content", "get-item", "get-itemproperty", "get-location",
  "select-string", "test-path", "resolve-path", "measure-object", "sort-object",
  "where-object", "select-object", "format-table", "format-list", "out-string",
  "write-output", "ls", "cat", "grep", "head", "tail", "wc", "stat", "file", "find",
]);
const SHELL_WRITE_MARKERS = /(^|\s)(rm|del|erase|mv|move|cp|copy|mkdir|md|touch|chmod|chown|sed|truncate)\s|set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|rename-item|clear-content|tee\b|>>?\s*\S/i;

/**
 * 只读 shell 命令的并行判定：分类器只认白名单里的命令；PowerShell 的大量只读
 * cmdlet 会被判 moderate（不进 auto 放行），但它们确实不改文件，理应能和 Read/
 * Grep 并行。这里只影响"同批能不能并发"，不改变权限分类，不放宽自动批准。
 */
function isReadOnlyShell(command: string): boolean {
  if (!command.trim() || SHELL_WRITE_MARKERS.test(command)) return false;
  const segments = command.split(/&&|\|\||;|\n/).map((part) => part.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    const head = segment.split(/\s+/)[0]!.replace(/^["']|["']$/g, "").toLowerCase();
    return READONLY_SHELL_HEADS.has(head);
  });
}

export const BashTool: Tool = {
  name: "Bash",
  description:
    "Execute a shell command and return exit_code, stdout and stderr. " +
    "On Windows the command runs in PowerShell (" + shellInfo.cmd + "); on POSIX in bash. " +
    "Commands are non-interactive and time out after 120s by default. " +
    "Use Read/Grep/Glob to inspect files and Edit to change them; reserve this tool for " +
    "builds, tests, git and process control.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line to execute." },
      description: { type: "string", description: "Short human-readable purpose (shown to the user)." },
      timeout_ms: { type: "number", description: "Timeout in milliseconds (default 120000)." },
      timeout: { type: "number", description: "Alias of timeout_ms." },
      run_in_background: { type: "boolean", description: "Start as a background job and return its id immediately (use JobOutput to read it)." },
    },
    required: ["command"],
  },
  isReadOnly: false,
  isDestructive: true,
  // 只读命令（分类器判定 safe）可以和同批的 Read/Grep 并行；写命令仍独占串行。
  // 判定用与 plan 模式同一套分类器，避免"看着安全其实会写"的命令混进并行批次。
  isConcurrencySafe: (input: Record<string, unknown>) => {
    const command = typeof input.command === "string" ? input.command : "";
    if (!command.trim()) return false;
    if (isReadOnlyShell(command)) return true;
    try {
      return classifyCommand(command).risk === "safe";
    } catch {
      return false;
    }
  },
  // 命令输出最容易失控（cat 一个日志就几百 KB）：30k 字符 ≈ 8k token
  maxOutputChars: 30_000,
  validate(input) {
    const cmd = str(input, "command");
    if (!cmd.trim()) return "command must not be empty";
    return null;
  },
  toolCheck(input, ctx) {
    // 用 shell 读文件是长任务里最常见的一类浪费：没有行号、不能分段、输出不可控。
    // 这里直接拒绝并给出替代工具，比在提示里请求它"优先用 Read"有效得多。
    const readOnlyShell = str(input, "command").trim();
    if (SHELL_FILE_READ.test(readOnlyShell)) {
      return {
        behavior: "deny",
        reason: "tool_check_deny",
        message:
          "Use Read (to open), Grep (to search) or Glob (to list) instead of shell file reading. " +
          "Those tools give line numbers, offsets and bounded output.",
      };
    }
    if (ctx.sandbox.mode === "read-only") {
      return {
        behavior: "ask",
        reason: "tool_check_ask",
        message: "Sandbox is read-only: shell commands cannot modify files without approval.",
      };
    }
    return null;
  },
  async call(input, ctx) {
    const command = str(input, "command");
    if (bool(input, "run_in_background", false)) {
      if (!ctx.jobs) return { content: "Background jobs are not enabled in this session.", isError: true };
      const job = ctx.jobs.start(command, { cwd: ctx.cwd, policy: ctx.sandbox });
      return {
        content: "started " + job.id + " in the background. Use JobOutput with job_id=" + job.id + " to read it, JobKill to stop it.",
        metadata: { jobId: job.id },
      };
    }
    // 模型有时会按 Claude Code 的习惯传 timeout（毫秒）；两个名字都接受。
    const timeoutMs = num(input, "timeout_ms", num(input, "timeout", 120_000));
    const result = await runCommand(command, {
      cwd: ctx.cwd,
      timeoutMs,
      signal: ctx.signal,
      policy: ctx.sandbox,
    });
    return { content: formatCommandResult(result), metadata: { exitCode: result.exitCode } };
  },
};

export const shellTools: Tool[] = [BashTool];
