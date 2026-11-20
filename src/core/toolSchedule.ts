/**
 * 工具调度的分组规则与结果反馈（从 query.ts 抽出，控制单文件规模）。
 *
 * 只读调用由 registry.partitionCalls() 聚成并行批；这里补上"写操作"的那一半：
 * 不同文件的 Edit/Write 彼此独立，可以一起跑；同文件必须保序；Bash 这类
 * 无法判定目标的调用永远单独执行。
 *
 * 另外承担两类"减少空转"的记账：
 *   1. 只读结果缓存——期间没有写操作时，同一调用不可能产生不同结果；
 *   2. 重复调用与验证命令族提示——git status/pytest 反复跑是最典型的浪费。
 */
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { stableKey } from "../util/async.ts";
import type { CallBatch, PreparedCall } from "../tools/registry.ts";
import type { Tool } from "../tools/types.ts";
import type { Message } from "./types.ts";

/** 文件写工具的目标路径；判定不了就返回 null（调用按原串行语义执行）。 */
export function writeTarget(call: PreparedCall, cwd: string): string | null {
  const name = call.request.name;
  if (name !== "Edit" && name !== "Write") return null;
  const raw = call.request.input?.file_path;
  if (typeof raw !== "string" || !raw.trim()) return null;
  return resolve(cwd, raw);
}

export interface WriteGroup {
  calls: PreparedCall[];
  /** 组内最后一个批次下标；调用方从 endIndex + 1 继续。 */
  endIndex: number;
}

/**
 * 从 batches[startIndex] 开始收集一个"可并行写"分组。
 * 遇到只读批、多调用批、无法判定目标的调用、重复目标或超过上限就停下。
 */
export function collectWriteGroup(
  batches: CallBatch[],
  startIndex: number,
  cwd: string,
  limit: number,
): WriteGroup {
  const first = batches[startIndex]!.calls[0]!;
  const calls = [first];
  const targets = new Set([writeTarget(first, cwd)]);
  let endIndex = startIndex;
  while (targets.size > 0 && endIndex + 1 < batches.length && calls.length < limit) {
    const next = batches[endIndex + 1]!;
    if (next.concurrencySafe || next.calls.length !== 1) break;
    const call = next.calls[0]!;
    const target = writeTarget(call, cwd);
    if (!target || targets.has(target)) break;
    targets.add(target);
    calls.push(call);
    endIndex++;
  }
  return { calls, endIndex };
}

export interface RepeatTracker {
  recentCallResults: Map<string, { fingerprint: string; count: number }>;
  commandFamilies: Map<string, number>;
}

/** 可以把结果缓存到"下一次写操作"为止的只读工具。 */
export const CACHEABLE_READ_TOOLS = new Set(["Bash", "Read", "Grep", "Glob"]);

/**
 * 只读验证命令的"族"：git status / git diff 参数千变万化，但它们是同一件事。
 * 族级计数才能识别"反复确认工作区"这类循环，精确命令比较会被 --short 之类绕过。
 */
export function commandFamily(name: string, input: Record<string, unknown>): string | null {
  if (name !== "Bash") return null;
  const command = String(input.command ?? "").replace(/\s+/g, " ").trim();
  if (!command) return null;
  const git = /(?:^|;|\|\||&&)\s*git\s+(?:--no-pager\s+)?([a-z][a-z-]*)/.exec(command);
  if (git) return "git:" + git[1];
  if (/(^|\s)(pytest|py\.test)\b|python\d?(\.exe)?\s+-m\s+pytest/.test(command)) return "pytest";
  return null;
}

/** 记录一次验证族调用；第二次起告诉模型不必再确认。 */
export function noteFamilyRepeat(tracker: RepeatTracker, family: string | null): string {
  if (!family) return "";
  const count = (tracker.commandFamilies.get(family) ?? 0) + 1;
  tracker.commandFamilies.set(family, count);
  if (count !== 2) return "";
  return (
    "\n\n[harness] You already ran a " + family + " command in this task. " +
    "Nothing changed unless you edited a file since then — do not re-check after every step."
  );
}

/**
 * 记录一次调用结果；同一调用连续第三次返回完全相同的内容时，返回一句提示。
 * 只提示、不拦截：只读工具重读同一文件是合法的，模型自己判断要不要换策略。
 */
export function noteRepeat(
  tracker: RepeatTracker,
  name: string,
  input: Record<string, unknown>,
  content: string,
  isError: boolean,
): string {
  // description 只是给人看的标签，不同描述不该算作不同调用。
  const keyInput = name === "Bash" ? { ...input, description: undefined } : input;
  const callKey = name + ":" + createHash("sha256").update(stableKey(keyInput)).digest("hex");
  const fingerprint = createHash("sha256").update(isError ? "1" : "0").update(content).digest("hex");
  const previous = tracker.recentCallResults.get(callKey);
  const repeats = previous?.fingerprint === fingerprint ? previous.count + 1 : 1;
  if (!previous && tracker.recentCallResults.size >= 256) {
    const oldest = tracker.recentCallResults.keys().next().value;
    if (oldest !== undefined) tracker.recentCallResults.delete(oldest);
  }
  tracker.recentCallResults.set(callKey, { fingerprint, count: repeats });
  if (repeats !== 3) return "";
  return (
    "\n\n[harness] This exact tool call has returned the same result three times. " +
    "Do not repeat it again unchanged; change the approach, batch related work, or finish."
  );
}

export interface ReadCacheState {
  writeEpoch: number;
  readOnlyCache: Map<string, { epoch: number; content: string; isError: boolean }>;
}

/** 只读调用是否可缓存：Read/Grep/Glob，以及被判定为只读的 shell 命令。 */
export function isCacheableRead(call: PreparedCall): boolean {
  if (!CACHEABLE_READ_TOOLS.has(call.request.name)) return false;
  if (call.tool?.isReadOnly === true) return true;
  return call.request.name === "Bash" && call.tool?.isConcurrencySafe(call.request.input) === true;
}

export function readCacheKey(call: PreparedCall): string {
  return call.request.name + ":" + stableKey(call.request.input);
}

const CACHED_NOTE =
  "\n\n[harness] Cached: no file changed since this exact call last ran, so the result is identical. Do not re-check; act on it.";

/** 命中"期间没有任何写操作"的缓存时返回带说明的结果，未命中返回 null。 */
export function readCacheHit(state: ReadCacheState, call: PreparedCall): { content: string; isError: boolean } | null {
  if (!isCacheableRead(call)) return null;
  const hit = state.readOnlyCache.get(readCacheKey(call));
  if (!hit || hit.epoch !== state.writeEpoch) return null;
  return { content: hit.content + CACHED_NOTE, isError: hit.isError };
}

/** 记录只读结果；写操作成功则推进纪元并整体失效缓存。 */
export function recordToolResult(state: ReadCacheState, call: PreparedCall, content: string, isError: boolean): void {
  if (isCacheableRead(call)) {
    if (state.readOnlyCache.size >= 128) {
      const oldest = state.readOnlyCache.keys().next().value;
      if (oldest !== undefined) state.readOnlyCache.delete(oldest);
    }
    state.readOnlyCache.set(readCacheKey(call), { epoch: state.writeEpoch, content, isError });
  }
  if (call.tool?.isReadOnly !== true && !isError) {
    state.writeEpoch++;
    state.readOnlyCache.clear();
  }
}

/** 重复调用 + 验证族两类反馈，合并成一段追加到工具结果末尾的文字。 */
export function toolFeedback(state: RepeatTracker, call: PreparedCall, content: string, isError: boolean): string {
  return (
    noteRepeat(state, call.request.name, call.request.input, content, isError) +
    noteFamilyRepeat(state, commandFamily(call.request.name, call.request.input))
  );
}

/** 追加一条仅模型可见的临时提示（不落盘、不算用户输入）。 */
export function pushMetaNote(
  state: { messages: Message[] },
  onState: ((messages: Message[]) => void) | undefined,
  text: string,
): void {
  state.messages = [
    ...state.messages,
    { role: "user", isMeta: true, content: [{ type: "text", text }] },
  ];
  try {
    onState?.(state.messages);
  } catch {
    /* best-effort state mirror */
  }
}

export interface TimingSource {
  modelMs: number;
  toolMs: number;
  ttftTotal: number;
  ttftCount: number;
  steps: number;
}

/** 累计耗时快照：模型 / 工具 / 首 token 平均 / 步数。 */
export function timingEvent(state: TimingSource): {
  type: "timing";
  modelMs: number;
  toolMs: number;
  ttftAvgMs: number | null;
  steps: number;
} {
  return {
    type: "timing",
    modelMs: state.modelMs,
    toolMs: state.toolMs,
    ttftAvgMs: state.ttftCount ? Math.round(state.ttftTotal / state.ttftCount) : null,
    steps: state.steps,
  };
}

/**
 * 只暴露当前真的能用的工具：没有技能时隐藏 Skill。
 * 长任务里每轮都要为工具 schema 付 token，留一个必然失败的工具不划算。
 */
export function visibleTools(tools: Tool[], hasSkills: boolean): Tool[] {
  return hasSkills ? tools : tools.filter((tool) => tool.name !== "Skill");
}

export interface ObservationState {
  /** 已观察过的文件：路径 -> 当时的 mtime 与大小，用来发现"读完之后被改过"。 */
  readFiles: Map<string, { mtimeMs: number; size: number }>;
}

const OBSERVED_TOOLS = new Set(["Edit", "Write"]);

function observedPath(call: PreparedCall, cwd: string): string | null {
  if (!OBSERVED_TOOLS.has(call.request.name)) return null;
  const raw = call.request.input?.file_path;
  if (typeof raw !== "string" || !raw.trim()) return null;
  return resolve(cwd, raw);
}

/**
 * 先读后写：没读过就不许改，读过但文件变了也不行（要求重读）。
 * 与 DSH 的 fs-observation-policy 同款策略——把"用 shell 瞄一眼再改"挤回 Read。
 * 目标文件不存在视为创建，允许通过。
 */
export async function checkObservation(
  state: ObservationState,
  call: PreparedCall,
  cwd: string,
): Promise<string | null> {
  const abs = observedPath(call, cwd);
  if (!abs) return null;
  const info = await stat(abs).catch(() => null);
  if (!info) return null;
  const seen = state.readFiles.get(abs);
  if (!seen) {
    return "Blocked: read " + abs + " before editing it. Call Read first, then retry this edit unchanged.";
  }
  if (seen.mtimeMs !== info.mtimeMs || seen.size !== info.size) {
    return "Blocked: " + abs + " changed since you last read it. Read it again, then retry this edit.";
  }
  return null;
}

/** 记录/刷新观察：Read 成功后登记，Edit/Write 成功后刷新，避免下一次编辑被自己的改动挡住。 */
export async function recordObservation(state: ObservationState, call: PreparedCall, cwd: string): Promise<void> {
  const name = call.request.name;
  if (name !== "Read" && name !== "Edit" && name !== "Write") return;
  const raw = call.request.input?.file_path;
  if (typeof raw !== "string" || !raw.trim()) return;
  const abs = resolve(cwd, raw);
  const info = await stat(abs).catch(() => null);
  if (info) state.readFiles.set(abs, { mtimeMs: info.mtimeMs, size: info.size });
  else state.readFiles.delete(abs);
}

const PRUNE_BUDGET = 20_000;

/**
 * 超长工具结果只保留头尾：中段对"下一步动作"几乎没有信息量，却会随每一轮
 * 重新发送、按轮次重复计费。保留尾部的意义是错误栈与汇总通常在最后。
 */
export function pruneResult(content: string): string {
  if (content.length <= PRUNE_BUDGET) return content;
  const head = Math.floor(PRUNE_BUDGET * 0.6);
  const tail = PRUNE_BUDGET - head;
  const omitted = content.length - PRUNE_BUDGET;
  const marker = "\n\n[... middle pruned: " + omitted + " chars ...]\n\n";
  return content.slice(0, head) + marker + content.slice(-tail);
}

export interface PreflightState {
  writeEpoch: number;
  /** 族级检查记录：族名 -> 当时的写纪元。 */
  familyChecks: Map<string, number>;
  /** 已执行的测试运行次数。 */
  testRuns: number;
}

/** 一个会话里允许的测试重跑上限：超过后必须先去改代码。 */
export const MAX_TEST_RUNS = 6;

/**
 * 执行前的两道闸：验证族短路 + 测试重跑上限。
 *
 * 族短路只声明"没有变化"，不复用上次的内容——不同 git 子命令的输出格式不同，
 * 直接回放旧内容会给出错误数据；而"期间没有任何写操作"本身就保证了状态未变。
 */
export function preflight(state: PreflightState, call: PreparedCall): string | null {
  if (call.request.name !== "Bash") return null;
  const family = commandFamily(call.request.name, call.request.input);
  if (!family) return null;

  if (family === "pytest") {
    if (state.testRuns >= MAX_TEST_RUNS) {
      return "Blocked: this task has already run tests " + state.testRuns + " times. Edit the code first; " +
        "re-running the same suite without a change cannot produce a different result.";
    }
    state.testRuns++;
    return null;
  }

  const lastEpoch = state.familyChecks.get(family);
  if (lastEpoch !== undefined && lastEpoch === state.writeEpoch) {
    return "Nothing changed since your last " + family + " check (no file was written). " +
      "Its earlier result still applies — act on it instead of re-checking.";
  }
  state.familyChecks.set(family, state.writeEpoch);
  return null;
}
