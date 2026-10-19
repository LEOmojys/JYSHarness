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
];

const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

export function decidePermission(
  req: PermissionRequest,
  ctx: DecisionContext,
): PermissionDecision {
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
  const candidates = absoluteContent && absoluteContent !== content ? [content, absoluteContent] : [content];
  const hits = candidates
    .map((c) => matchRules(ctx.rules, req.toolName, c))
    .filter((h): h is NonNullable<typeof h> => Boolean(h));
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
    case "auto":
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
