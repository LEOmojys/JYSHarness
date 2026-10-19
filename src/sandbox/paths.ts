/**
 * Filesystem sandbox (ch.7). Containment is computed on *real* paths so that
 * `..` traversal and symlinks pointing outside the workspace cannot escape.
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import type { PermissionDecision } from "../permissions/engine.ts";

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
const PROTECTED = [".git", "node_modules", ".harness/settings.json"];

function touchesProtected(root: string, target: string): string | null {
  const rel = path.relative(root, target).split(path.sep).join("/");
  for (const p of PROTECTED) {
    if (rel === p || rel.startsWith(p + "/")) return p;
  }
  return null;
}

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
  }

  return { decision: null, resolved };
}

export function describeSandbox(p: SandboxPolicy): string {
  return "sandbox=" + p.mode + " root=" + p.workspaceRoot;
}
