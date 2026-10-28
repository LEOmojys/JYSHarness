/**
 * Permission decision pipeline (ch.5.4) — deny rules always win.
 *
 * Order is deliberate and must not be reordered:
 *   hardcoded denial -> deny rule -> ask rule -> tool check ->
 *   allow rule -> mode policy -> default(ask)
 *
 * Every branch returns a *reason* so the UI can explain itself. A permission
 * system that cannot explain its decision trains users to blindly approve.
 */
import {
  matchRules,
  permissionContentFor,
  type PermissionRule,
  type RuleSet,
} from "./rules.ts";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions"
  | "dontAsk"
  | "auto";

export type PermissionBehavior = "allow" | "deny" | "ask";

export type PermissionReason =
  | "hardcoded_deny"
  | "rule_deny"
  | "rule_ask"
  | "tool_check_deny"
  | "tool_check_ask"
  | "rule_allow"
  | "mode_bypass"
  | "mode_accept_edits"
  | "mode_plan_deny"
  | "mode_dont_ask"
  | "read_only_default"
  | "auto_safe_command"
  | "auto_needs_review"
  | "default_ask";

export interface PermissionDecision {
  behavior: PermissionBehavior;
  reason: PermissionReason;
  /** Human-readable explanation, shown in the approval prompt. */
  message: string;
  matchedRule?: PermissionRule;
  /** Rule the user could add to stop being asked. */
  suggestedRule?: string;
}

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  isReadOnly: boolean;
  isDestructive?: boolean;
  /** Tool-specific override, evaluated before generic rules. */
  toolCheck?: (input: Record<string, unknown>) => PermissionDecision | null;
}

export interface DecisionContext {
  mode: PermissionMode;
  rules: RuleSet;
  /** Filesystem sandbox mode; readonly forces writes to ask/deny. */
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  workspaceRoot: string;
}

import { classifyCommand, splitShellSegments } from "./classify.ts";
import { contentCandidates, ruleMatches } from "./rules.ts";

/** Layer 6: unoverridable denials. Not configurable by design. */
const HARDCODED_DENY: { pattern: RegExp; why: string }[] = [
  { pattern: /\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rf][a-zA-Z]*\s+\/(\s|$)/, why: "recursive delete of /" },
  { pattern: /\brm\s+(-[a-zA-Z]+\s+)*~\/?\s*$/, why: "delete of home directory" },
  { pattern: /: \(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: "fork bomb" },
  { pattern: /\b(mkfs|fdisk|diskpart)\b/i, why: "filesystem/drive modification" },
  { pattern: /\bdd\s+.*of=\/dev\/(sd|nvme|disk)/i, why: "raw disk write" },
  { pattern: /\b(shutdown|reboot|halt)\b/i, why: "system power state change" },
  { pattern: /\bformat\s+[a-z]:/i, why: "drive format" },
  { pattern: /\bgit\s+push\s+(-f|--force)\b/, why: "history-rewriting force push" },
  // "+refspec" 是 force push 的另一种写法，容易被漏掉
  { pattern: /\bgit\s+push\b[^;&|]*\s\+[A-Za-z0-9_]/, why: "force push via +refspec" },
  // 删 / 和 /*（后者比 "/" 更彻底），以及绕过保护的 flag
  { pattern: /\brm\s+(-[^\s]+\s+)*\/\*(\s|$)/, why: "delete everything under /" },
  { pattern: /--no-preserve-root/, why: "bypassing the root-delete guard" },
  // Windows 原生等价物：之前完全没覆盖
  { pattern: /\b(Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition)\b/i, why: "disk formatting" },
  { pattern: /\b(Stop-Computer|Restart-Computer)\b/i, why: "system power state change" },
  { pattern: /\b(Remove-Item|del|rd|rmdir)\b[^;&|]*-[Rr]ecurse[^;&|]*\b[a-zA-Z]:\\?(Windows|Users|Program Files|ProgramData)?(\s|$|[^A-Za-z0-9])/i, why: "recursive delete of a system directory or drive root" },
  { pattern: /\b(del|rd|rmdir)\s+\/[sq][^;&|]*\b[a-zA-Z]:\\?(\s|$)/i, why: "recursive delete of a drive root" },
  { pattern: /\bdel\s+\/[sq]\b[^;&|]*\b[a-zA-Z]:\\?(Windows|Users|Program Files|ProgramData)?(\s|$|[^A-Za-z0-9])/i, why: "recursive delete of a system directory" },
];

const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

export function decidePermission(
  req: PermissionRequest,
  ctx: DecisionContext,
): PermissionDecision {
  // Defensive: a caller without a rule set should behave like "no rules",
  // never crash the tool call.
  if (!ctx.rules) ctx = { ...ctx, rules: { allow: [], deny: [], ask: [] } };
  const content = permissionContentFor(req.toolName, req.input, ctx.workspaceRoot);
  // A rule written with an absolute path must still work.
  const absoluteContent = permissionContentFor(req.toolName, req.input);

  // --- Layer 6: hardcoded denials (shell tools only) ---
  if (req.toolName === "Bash" || req.toolName === "PowerShell") {
    for (const { pattern, why } of HARDCODED_DENY) {
      if (pattern.test(content)) {
        return {
          behavior: "deny",
          reason: "hardcoded_deny",
          message: `Blocked by hardcoded policy: ${why}. This cannot be overridden.`,
        };
      }
    }
  }

  // --- Declarative rules (deny > ask > allow) ---
  // 路径类工具要同时试几种等价写法（./x、x、x\y），否则 deny 规则能被换个写法绕开。
  const PATH_TOOLS = new Set(["Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep"]);
  const baseCandidates = PATH_TOOLS.has(req.toolName) ? contentCandidates(content) : [content];
  const candidates = [...new Set([...baseCandidates, ...(absoluteContent && absoluteContent !== content ? [absoluteContent] : [])])];
  let hits = candidates
    .map((c) => matchRules(ctx.rules, req.toolName, c))
    .filter((h): h is NonNullable<typeof h> => Boolean(h));

  // deny / ask 规则也要逐段看：`Bash(rm *)` 必须能挡住 `git status && rm -rf build`。
  // 不这样做，拒绝规则只对"整条命令恰好长得像"的情况生效，等于形同虚设。
  // 注意：这里**不**提升逐段的 allow —— 允许必须覆盖整条命令（见下面的处理）。
  if ((req.toolName === "Bash" || req.toolName === "PowerShell") && !hits.some((h) => h.behavior === "deny")) {
    for (const segment of splitShellSegments(content)) {
      const segHit = matchRules(ctx.rules, req.toolName, segment);
      if (!segHit) continue;
      if (segHit.behavior === "deny") {
        hits = [segHit, ...hits];
        break;
      }
      if (segHit.behavior === "ask" && !hits.some((h) => h.behavior === "ask")) {
        hits = [segHit, ...hits];
      }
    }
  }

  const match =
    hits.find((h) => h.behavior === "deny") ??
    hits.find((h) => h.behavior === "ask") ??
    hits.find((h) => h.behavior === "allow") ??
    null;
  if (match?.behavior === "deny") {
    return {
      behavior: "deny",
      reason: "rule_deny",
      message: `Denied by ${match.rule.source} rule.`,
      matchedRule: match.rule,
    };
  }
  if (match?.behavior === "ask") {
    return {
      behavior: "ask",
      reason: "rule_ask",
      message: `${match.rule.source} rule requires confirmation.`,
      matchedRule: match.rule,
      suggestedRule: `${req.toolName}(${content || "*"})`,
    };
  }

  // --- Tool-specific check (path containment, etc.) ---
  const toolDecision = req.toolCheck?.(req.input) ?? null;
  if (toolDecision && toolDecision.behavior !== "allow") return toolDecision;

  if (match?.behavior === "allow") {
    // 允许规则必须覆盖**整条**命令，而不只是其中一段。
    // 否则 `Bash(git *)` 会连带放行 `git status && rm -rf ~` —— 前缀匹配把
    // 后面追加的任意命令一起洗白了。逐段匹配是这里唯一安全的判据。
    const shell = req.toolName === "Bash" || req.toolName === "PowerShell";
    if (shell && match.rule.ruleValue.ruleContent) {
      const segments = splitShellSegments(content);
      const everySegmentAllowed = segments.length > 0 && segments.every((seg) => ruleMatches(match.rule, req.toolName, seg));
      if (!everySegmentAllowed) {
        return {
          behavior: "ask",
          reason: "rule_ask",
          message:
            "允许规则只匹配了复合命令的一部分，需要确认整条命令：" +
            segments.filter((seg) => !ruleMatches(match.rule, req.toolName, seg)).map((s) => s.slice(0, 60)).join(" | "),
          matchedRule: match.rule,
        };
      }
    }
    return {
      behavior: "allow",
      reason: "rule_allow",
      message: `Allowed by ${match.rule.source} rule.`,
      matchedRule: match.rule,
    };
  }

  // --- Mode policy ---
  switch (ctx.mode) {
    case "bypassPermissions":
      return { behavior: "allow", reason: "mode_bypass", message: "bypassPermissions mode." };
    case "plan": {
      const writing = WRITE_TOOLS.has(req.toolName) || (!req.isReadOnly && req.isDestructive);
      if (writing) {
        return {
          behavior: "deny",
          reason: "mode_plan_deny",
          message: "Plan mode is read-only. Exit plan mode to make changes.",
        };
      }
      return { behavior: "allow", reason: "mode_plan_deny", message: "Plan mode: read-only allowed." };
    }
    case "acceptEdits":
      if (WRITE_TOOLS.has(req.toolName) && ctx.sandboxMode !== "read-only") {
        return {
          behavior: "allow",
          reason: "mode_accept_edits",
          message: "acceptEdits mode auto-approves file edits.",
        };
      }
      break;
    case "dontAsk":
      return {
        behavior: "deny",
        reason: "mode_dont_ask",
        message: "dontAsk mode: operations needing approval are auto-denied.",
      };
    case "auto": {
      // 风险分类器（ch.5.7）：只放行"能证明安全"的，其余一律升到 ask。
      // 它绝不越过前面的 hardcoded deny 与 deny 规则 —— 位置就在这条链的末尾。
      if (req.toolName === "Bash") {
        const command = String((req.input as { command?: unknown }).command ?? "");
        const verdict = classifyCommand(command);
        if (verdict.risk === "safe") {
          return { behavior: "allow", reason: "auto_safe_command", message: "auto: " + verdict.why };
        }
        return {
          behavior: "ask",
          reason: "auto_needs_review",
          message: "auto 模式需要确认（" + verdict.why + "）：" + command.slice(0, 120),
        };
      }
      if (req.isReadOnly) {
        return { behavior: "allow", reason: "auto_safe_command", message: "auto: 只读工具" };
      }
      return {
        behavior: "ask",
        reason: "auto_needs_review",
        message: "auto 模式：写操作需要确认（" + req.toolName + "）",
      };
    }
    case "default":
      break;
  }

  // --- Read-only fast path ---
  if (req.isReadOnly) {
    return { behavior: "allow", reason: "read_only_default", message: "Read-only tool." };
  }

  // --- Sandbox interaction ---
  if (ctx.sandboxMode === "read-only" && WRITE_TOOLS.has(req.toolName)) {
    return {
      behavior: "deny",
      reason: "tool_check_deny",
      message: "Filesystem sandbox is read-only; writes are blocked.",
    };
  }

  return {
    behavior: "ask",
    reason: "default_ask",
    message: "Requires approval.",
    suggestedRule: `${req.toolName}(${content || "*"})`,
  };
}

/** Human label used by the REPL prompt. */
export function describeDecision(d: PermissionDecision): string {
  const tag = d.behavior === "allow" ? "ALLOW" : d.behavior === "deny" ? "DENY" : "ASK";
  return `${tag} [${d.reason}] ${d.message}`;
}
