/**
 * 工具执行前的安全闸门：PreToolUse 钩子 + 权限管道。
 *
 * 从 query.ts 里拆出来（那个文件负责"循环怎么转"，这里负责"这一调用准不准"）。
 * 两者混在一起时，改权限逻辑要在一千行的循环里翻找，改循环又要小心别碰权限。
 */
import { runHooks } from "../hooks/hooks.ts";
import { decidePermission, type PermissionDecision } from "../permissions/engine.ts";
import { describeSandbox } from "../sandbox/paths.ts";
import { validateAgainstSchema } from "../tools/types.ts";
import type { PreparedCall } from "../tools/registry.ts";
import type { ToolResult } from "../tools/types.ts";
import type { ToolResultBlock } from "./types.ts";
import type { QueryParams } from "./query.ts";

export function toResultBlock(id: string, _name: string, r: ToolResult): ToolResultBlock {
  return { type: "tool_result", tool_use_id: id, content: r.content, is_error: r.isError };
}

/** PreToolUse hook + permission pipeline. Returns a blocking tool_result, or null if allowed. */
export async function gateCall(
  call: PreparedCall,
  params: QueryParams,
): Promise<ToolResultBlock | null> {
  const { request } = call;
  if (call.errorResult || call.validationError) {
    const content = call.errorResult?.content ?? "<tool_use_error>" + call.validationError + "</tool_use_error>";
    return { type: "tool_result", tool_use_id: request.id, content, is_error: true };
  }
  const tool = call.tool!;

  // Layer 3: PreToolUse hooks.
  const pre = await runHooks(
    params.hooks?.PreToolUse,
    {
      event: "PreToolUse",
      sessionId: params.sessionId,
      cwd: params.toolContext.cwd,
      toolName: request.name,
      toolInput: request.input,
    },
    { cwd: params.toolContext.cwd, logger: params.logger, signal: params.signal },
  );
  if (params.signal.aborted) {
    return {
      type: "tool_result",
      tool_use_id: request.id,
      content: "<tool_use_error>Tool call cancelled before execution.</tool_use_error>",
      is_error: true,
    };
  }
  if (pre.decision === "deny") {
    return {
      type: "tool_result",
      tool_use_id: request.id,
      content: "<tool_use_error>Blocked by PreToolUse hook: " + (pre.reason ?? "unspecified") + "</tool_use_error>",
      is_error: true,
    };
  }
  if (pre.updatedInput) {
    const next = { ...request.input, ...pre.updatedInput };
    // hook 改完参数必须重新过一遍 schema/validate。prepareCall 校验的是**原始**输入，
    // 之后没有第二道关，于是 hook 能把 `{file_path: ["a"]}` / `{command: {}}` 这类
    // 非法值直接送进工具，表现成 "Tool threw an error" 而不是可纠正的 tool_use_error。
    const schemaError = validateAgainstSchema(tool.inputSchema, next);
    const customError = schemaError ? null : (tool.validate?.(next) ?? null);
    const invalid = schemaError ?? customError;
    if (invalid) {
      return {
        type: "tool_result",
        tool_use_id: request.id,
        content: "<tool_use_error>PreToolUse hook produced an invalid input: " + invalid + "</tool_use_error>",
        is_error: true,
      };
    }
    request.input = next;
  }

  // Layers 2/4/5: declarative rules, tool checks, mode policy.
  const decision = decidePermission(
    {
      toolName: request.name,
      input: request.input,
      isReadOnly: tool.isReadOnly,
      isDestructive: tool.isDestructive,
      toolCheck: tool.toolCheck ? (input) => tool.toolCheck!(input, params.toolContext) : undefined,
    },
    params.permission,
  );

  let final: PermissionDecision = decision;
  if (decision.behavior === "ask") {
    const outcome = await params.approve({
      toolName: request.name,
      input: request.input,
      decision,
      origin: params.toolContext.depth > 0 ? "subagent" : undefined,
    });
    if (params.signal.aborted) {
      return {
        type: "tool_result",
        tool_use_id: request.id,
        content: "<tool_use_error>Tool call cancelled while awaiting approval.</tool_use_error>",
        is_error: true,
      };
    }
    if (outcome === "always") {
      params.onAlwaysAllow?.(request.name, request.input);
      final = { behavior: "allow", reason: "rule_allow", message: "approved by user (always)" };
    } else if (outcome === "allow") {
      final = { behavior: "allow", reason: "rule_allow", message: "approved by user" };
    } else {
      final = { behavior: "deny", reason: "rule_deny", message: "rejected by user" };
    }
  }

  if (final.behavior === "deny") {
    return {
      type: "tool_result",
      tool_use_id: request.id,
      content:
        "<tool_use_error>Permission denied for " +
        request.name +
        ": " +
        final.message +
        " [" +
        final.reason +
        "] Do not retry the same call; adjust your approach or ask the user.</tool_use_error>",
      is_error: true,
    };
  }
  return null;
}
