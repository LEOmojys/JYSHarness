/**
 * Filesystem sandbox (ch.7). Containment is computed on *real* paths so that
 * `..` traversal and symlinks pointing outside the workspace cannot escape.
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import type { PermissionDecision } from "../permissions/engine.ts";
import { detectBackend } from "./policy.ts";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface SandboxPolicy {
  mode: SandboxMode;
  workspaceRoot: string;
}

/** Resolve the longest existing prefix through realpath, then re-append the rest. */
export function realResolve(p: string): string {
  let abs = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(abs);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(abs);
      if (parent === abs) return path.resolve(p);
      rest.push(path.basename(abs));
      abs = parent;
    }
  }
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Paths that are never writable, even inside the workspace. */
/**
 * 硬编码的不可写路径（**不依赖任何配置**，也改不了）。
 *
 * 这些不是"普通文件"：写它们等于改未来的行为或改历史。
 *   - settings：权限规则、沙箱模式、钩子
 *   - skills：会被注入系统提示的指令（写它 = 持久化提示注入）
 *   - sessions：转录，改它等于篡改"发生过什么"
 */
const PROTECTED = [
  ".git",
  "node_modules",
  ".harness/settings.json",
  ".harness/sessions",
  ".harness/skills",
  // 改 agent 定义等于给子 Agent 扩权（explore -> 全工具）：和技能同级保护
  ".harness/agents",
  ".jysharness/settings.json",
  ".jysharness/settings.local.json",
];

/**
 * 敏感但不绝对禁止：这些文件会改变**未来的行为**（项目约定、插件代码、
 * 本地覆盖配置）。写它们不是"改一个文件"，而是"改以后每一次会话"，
 * 所以必须让人确认一次，而不是静默放行。
 */
const SENSITIVE = [
  "AGENTS.md",
  "CLAUDE.md",
  "JYS.md",
  "HARNESS.md",
  ".harness/plugins",
];

function touchesList(root: string, target: string, list: string[]): string | null {
  const rel = path.relative(root, target).split(path.sep).join("/");
  for (const p of list) {
    if (rel === p || rel.startsWith(p + "/")) return p;
  }
  return null;
}

const touchesProtected = (root: string, target: string): string | null => touchesList(root, target, PROTECTED);

export interface PathCheckResult {
  decision: PermissionDecision | null;
  resolved: string;
}

export function guardPath(
  raw: string,
  opts: { access: "read" | "write"; policy: SandboxPolicy },
): PathCheckResult {
  const resolved = realResolve(raw);
  const mode = opts.policy.mode;
  // Normalise the root too: on Windows the temp/cwd path can come back in 8.3
  // short form ("PROGRA~1") while the target resolves to the long form, which
  // would make every containment check fail.
  const workspaceRoot = realResolve(opts.policy.workspaceRoot);

  if (mode === "danger-full-access") {
    return { decision: null, resolved };
  }

  const inside = isInside(workspaceRoot, resolved);

  // 别的任务的 git worktree 就在 .harness/worktrees/ 下面，物理上"在工作区内"，
  // 但它是另一个任务的独立沙箱。这里显式挡住，避免 Agent 顺手改掉另一个任务的文件。
  if (inside) {
    const rel = path.relative(workspaceRoot, resolved).split(path.sep).join("/");
    if (rel === ".harness/worktrees" || rel.startsWith(".harness/worktrees/")) {
      return {
        decision: {
          behavior: "deny",
          reason: "tool_check_deny",
          message: "该路径属于另一个任务的工作树（.harness/worktrees），请切换到那个工作树再操作。",
        },
        resolved,
      };
    }
  }

  if (!inside) {
    return {
      decision: {
        behavior: "ask",
        reason: "tool_check_ask",
        message: "Path is outside the workspace (" + workspaceRoot + ").",
      },
      resolved,
    };
  }

  if (opts.access === "write") {
    if (mode === "read-only") {
      return {
        decision: {
          behavior: "deny",
          reason: "tool_check_deny",
          message: "Filesystem sandbox mode is read-only.",
        },
        resolved,
      };
    }
    const prot = touchesProtected(workspaceRoot, resolved);
    if (prot) {
      return {
        decision: {
          behavior: "deny",
          reason: "hardcoded_deny",
          message: "Refusing to write into protected path: " + prot,
        },
        resolved,
      };
    }
    const sensitive = touchesList(workspaceRoot, resolved, SENSITIVE);
    if (sensitive) {
      return {
        decision: {
          behavior: "ask",
          reason: "tool_check_ask",
          message: "该路径会影响以后的会话行为（" + sensitive + "），需要你确认后再写。",
        },
        resolved,
      };
    }
  }

  return { decision: null, resolved };
}

export function describeSandbox(p: SandboxPolicy): string {
  return "sandbox=" + p.mode + " root=" + p.workspaceRoot;
}

export interface SandboxEnforcement {
  mode: SandboxMode;
  /** 实际可用的后端：win-lowil / bwrap / sandbox-exec / none */
  backend: string;
  /** 是否有内核级强制。false 时只剩路径与规则检查。 */
  enforced: boolean;
  /** 给 UI 的一句话说明（含"为什么没强制"）。 */
  note: string;
}

/**
 * 模式是"我想要什么"，这个函数回答"实际有什么"。
 *
 * 沙箱装不上（没有 csc.exe、没有 bwrap、权限不足）时不能假装还在沙箱里：
 * 面板必须显示"未强制"，否则用户以为有内核保护，实际上只有路径检查。
 */
export function sandboxEnforcement(mode: SandboxMode): SandboxEnforcement {
  if (mode === "danger-full-access") {
    return { mode, backend: "none", enforced: false, note: "danger-full-access：已主动关闭 OS 沙箱，仅保留路径与规则检查" };
  }
  const backend = detectBackend();
  const enforced = backend.kind !== "none";
  return {
    mode,
    backend: backend.kind,
    enforced,
    note: enforced ? backend.note : "OS 沙箱不可用，只剩路径/命令检查（" + backend.note + "）",
  };
}

/** Human-readable backend line for the banner (real enforcement, not intent). */
export function describeSandboxBackend(mode: SandboxMode): string {
  if (mode === "danger-full-access") return "OS 沙箱：关闭（danger-full-access，仅路径/规则检查）";
  const backend = detectBackend();
  const label =
    backend.kind === "win-lowil"
      ? "低完整性令牌 + Job Object（内核强制）"
      : backend.kind === "bwrap"
        ? "bubblewrap"
        : backend.kind === "sandbox-exec"
          ? "seatbelt"
          : "无";
  return "OS 沙箱：" + label + " — " + backend.note;
}
