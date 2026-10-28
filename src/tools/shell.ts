import { formatCommandResult, runCommand, shellForPlatform } from "../sandbox/commands.ts";
import { bool, num, str, type Tool } from "./types.ts";

const shellInfo = shellForPlatform();

export const BashTool: Tool = {
  name: "Bash",
  description:
    "Execute a shell command and return exit_code, stdout and stderr. " +
    "On Windows the command runs in PowerShell (" + shellInfo.cmd + "); on POSIX in bash. " +
    "Commands are non-interactive and time out after 120s by default.",
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
  isConcurrencySafe: () => false,
  // 命令输出最容易失控（cat 一个日志就几百 KB）：30k 字符 ≈ 8k token
  maxOutputChars: 30_000,
  validate(input) {
    const cmd = str(input, "command");
    if (!cmd.trim()) return "command must not be empty";
    return null;
  },
  toolCheck(input, ctx) {
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
