import { test } from "node:test";
import assert from "node:assert/strict";
import { partitionCalls, prepareCall, executeCall, ToolRegistry } from "../src/tools/registry.ts";
import { DEFAULT_MAX_OUTPUT_CHARS, truncateOutput, validateAgainstSchema, type Tool } from "../src/tools/types.ts";
import { emptyRuleSet } from "../src/permissions/rules.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { Logger } from "../src/util/log.ts";
import { BREAKER_COOLDOWN_MS, ToolHealth } from "../src/core/toolHealth.ts";

const logger = new Logger("error");

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    cwd: process.cwd(),
    sandbox: { mode: "danger-full-access", workspaceRoot: process.cwd() },
    signal: new AbortController().signal,
    logger,
    depth: 0,
    ...over,
  } as ToolContext;
}

function tool(over: Partial<Tool> & { name: string }): Tool {
  return {
    description: "d",
    inputSchema: { type: "object", properties: {} },
    isReadOnly: true,
    isConcurrencySafe: () => true,
    async call() {
      return { content: "ok" };
    },
    ...over,
  } as Tool;
}

test("tools: a huge result is truncated with both head and tail kept", async () => {
  const body = "HEAD-" + "x".repeat(200_000) + "-TAIL";
  const huge = tool({ name: "Huge", async call() { return { content: body }; } });
  const call = prepareCall({ get: () => huge, names: () => ["Huge"] }, { id: "1", name: "Huge", input: {} });
  const result = await executeCall(call, ctx());
  assert.ok(result.content.length <= DEFAULT_MAX_OUTPUT_CHARS + 200, "kept " + result.content.length);
  assert.ok(result.content.startsWith("HEAD-"), "head must survive");
  assert.ok(result.content.includes("-TAIL"), "tail must survive");
  assert.match(result.content, /chars omitted/);
  assert.equal((result.metadata as { truncated?: { original: number } })?.truncated?.original, body.length);
});

test("tools: a per-tool cap overrides the default", async () => {
  const small = tool({ name: "Small", maxOutputChars: 100, async call() { return { content: "y".repeat(5000) }; } });
  const call = prepareCall({ get: () => small, names: () => ["Small"] }, { id: "1", name: "Small", input: {} });
  const result = await executeCall(call, ctx());
  assert.ok(result.content.length <= 101 + 400, "cap honoured, got " + result.content.length);
});

test("tools: short results pass through untouched", async () => {
  const echo = tool({ name: "Echo", async call() { return { content: "short" }; } });
  const call = prepareCall({ get: () => echo, names: () => ["Echo"] }, { id: "1", name: "Echo", input: {} });
  const result = await executeCall(call, ctx());
  assert.equal(result.content, "short");
  assert.equal((result.metadata as { truncated?: unknown })?.truncated, undefined);
});

test("tools: a hanging tool times out instead of blocking the loop", async () => {
  const hang = tool({
    name: "Hang",
    timeoutMs: 40,
    async call() {
      await new Promise((r) => setTimeout(r, 5000));
      return { content: "never" };
    },
  });
  const call = prepareCall({ get: () => hang, names: () => ["Hang"] }, { id: "1", name: "Hang", input: {} });
  const started = Date.now();
  const result = await executeCall(call, ctx());
  assert.equal(result.isError, true);
  assert.match(result.content, /timed out after 40ms/);
  assert.ok(Date.now() - started < 1000, "must not wait for the tool");
});

test("tools: a tool without timeoutMs is not cut off", async () => {
  const slow = tool({ name: "Slow", async call() { await new Promise((r) => setTimeout(r, 60)); return { content: "done" }; } });
  const call = prepareCall({ get: () => slow, names: () => ["Slow"] }, { id: "1", name: "Slow", input: {} });
  const result = await executeCall(call, ctx());
  assert.equal(result.isError, undefined);
  assert.equal(result.content, "done");
});

test("tools: schema validation rejects missing, mistyped and unexpected properties", () => {
  const schema = { type: "object" as const, properties: { s: { type: "string" }, n: { type: "number" } }, required: ["s"], additionalProperties: false };
  assert.match(validateAgainstSchema(schema, {}) ?? "", /missing required/);
  assert.match(validateAgainstSchema(schema, { s: 1 }) ?? "", /must be of type string/);
  assert.match(validateAgainstSchema(schema, { s: "x", extra: 1 }) ?? "", /unexpected property/);
  assert.equal(validateAgainstSchema(schema, { s: "x", n: 2 }), null);
  assert.equal(validateAgainstSchema(schema, { s: "x", n: 2, n2: 3 } as never), "unexpected property: n2");
});

test("tools: unknown tool names produce an actionable error, not a crash", () => {
  const call = prepareCall({ get: () => undefined, names: () => ["Read", "Bash"] }, { id: "1", name: "Nope", input: {} });
  assert.ok(call.errorResult);
  assert.match(call.errorResult!.content, /No such tool: Nope/);
  assert.match(call.errorResult!.content, /Available tools: Read, Bash/);
});

test("tools: duplicate registration is rejected at startup", () => {
  const reg = new ToolRegistry();
  reg.register(tool({ name: "A" }));
  assert.throws(() => reg.register(tool({ name: "A" })), /duplicate tool name/);
});

test("tools: assembly is sorted, builtins first, extensions deduped", () => {
  const reg = new ToolRegistry();
  reg.registerAll([tool({ name: "Zeta" }), tool({ name: "Alpha" })]);
  const out = reg.assemble([tool({ name: "Beta" }), tool({ name: "Alpha", description: "shadow" })]);
  assert.deepEqual(out.map((t) => t.name), ["Alpha", "Zeta", "Beta"], "builtins sorted first, extension override ignored");
});

test("tools: concurrency partitioning groups consecutive read-only calls only", () => {
  const read = tool({ name: "Read" });
  const write = tool({ name: "Write", isReadOnly: false, isConcurrencySafe: () => false });
  const lookup = { get: (n: string) => (n === "Read" ? read : write), names: () => ["Read", "Write"] };
  const calls = [
    prepareCall(lookup, { id: "1", name: "Read", input: {} }),
    prepareCall(lookup, { id: "2", name: "Read", input: {} }),
    prepareCall(lookup, { id: "3", name: "Write", input: {} }),
    prepareCall(lookup, { id: "4", name: "Read", input: {} }),
  ];
  const batches = partitionCalls(calls);
  assert.deepEqual(batches.map((b) => [b.concurrencySafe, b.calls.length]), [[true, 2], [false, 1], [true, 1]]);
});

test("tools: a slow read batch really runs in parallel", async () => {
  const slowRead = tool({
    name: "SlowRead",
    async call() {
      await new Promise((r) => setTimeout(r, 80));
      return { content: "done" };
    },
  });
  const lookup = { get: () => slowRead, names: () => ["SlowRead"] };
  const calls = [1, 2, 3, 4].map((i) => prepareCall(lookup, { id: String(i), name: "SlowRead", input: {} }));
  const started = Date.now();
  await Promise.all(calls.map((c) => executeCall(c, ctx())));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 250, "4x80ms serialised would be 320ms, got " + elapsed);
});

test("truncateOutput: marker reports the omitted size and keeps the tail", () => {
  const body = "a".repeat(1000) + "END";
  const out = truncateOutput(body, 200);
  assert.equal(out.truncated, true);
  assert.ok(out.content.endsWith("END"));
  assert.ok(out.content.includes("of " + body.length + " chars omitted"), "marker must report the real size: " + out.content.slice(100, 160));
  assert.equal(truncateOutput("short", 200).truncated, false);
});

test("tools: command output keeps the tail so the real error stays visible", async () => {
  const { formatCommandResult } = await import("../src/sandbox/commands.ts");
  const out = formatCommandResult({
    stdout: "HEAD-" + "z".repeat(120_000) + "-TAIL-ERROR",
    stderr: "",
    exitCode: 1,
    timedOut: false,
    truncated: false,
  });
  assert.ok(out.startsWith("exit_code=1"));
  assert.ok(out.includes("HEAD-"), "head kept");
  assert.ok(out.includes("-TAIL-ERROR"), "tail kept: the last lines are where failures are reported");
  assert.match(out, /chars omitted/);
});

test("layering: sandbox code does not import tools (shared truncation lives in util)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/sandbox/commands.ts", import.meta.url), "utf8");
  assert.ok(!src.includes('"../tools/'), "sandbox must not depend on tools");
  assert.ok(src.includes('"../util/truncate.ts"'), "use the shared truncation helper");
});

test("tools: identical read-only calls in one batch run once and are marked deduped", async () => {
  const { queryLoop } = await import("../src/core/query.ts");
  const { emptyRuleSet } = await import("../src/permissions/rules.ts");
  const { Logger } = await import("../src/util/log.ts");
  let calls = 0;
  const read = tool({
    name: "Read",
    async call() {
      calls++;
      return { content: "file body" };
    },
  });
  const provider = {
    id: "f",
    model: "f",
    requests: [] as unknown[],
    async *stream(req: { messages: unknown[] }) {
      this.requests.push(req);
      if (this.requests.length === 1) {
        yield {
          type: "done" as const,
          message: {
            role: "assistant" as const,
            content: [
              { type: "tool_use", id: "t1", name: "Read", input: { file_path: "same.ts" } },
              { type: "tool_use", id: "t2", name: "Read", input: { file_path: "same.ts" } },
            ],
            stopReason: "tool_use",
          },
        };
      } else {
        yield { type: "done" as const, message: { role: "assistant" as const, content: [{ type: "text", text: "ok" }], stopReason: "end_turn" } };
      }
    },
  };
  const events: any[] = [];
  const it = queryLoop({
    provider: provider as never,
    model: "f",
    systemPrompt: "s",
    messages: [{ role: "user", content: [{ type: "text", text: "read it twice" }] }],
    tools: [read],
    preloadedToolMap: new Map([["Read", read]]),
    permission: { mode: "bypassPermissions", rules: emptyRuleSet(), sandboxMode: "danger-full-access", workspaceRoot: process.cwd() },
    toolContext: ctx(),
    hooks: {},
    logger,
    sessionId: "dedupe",
    maxTurns: 3,
    maxTokens: 100,
    signal: new AbortController().signal,
    approve: async () => "allow",
  } as never);
  for (;;) {
    const r = await it.next();
    if (r.done) break;
    events.push(r.value);
  }
  assert.equal(calls, 1, "the tool itself must run once");
  const ends = events.filter((e) => e.type === "tool_end");
  assert.equal(ends.length, 2, "but both tool_use ids must get a result");
  const deduped = ends.find((e) => e.id === "t2");
  assert.equal((deduped.result.metadata as { dedupedFrom?: string })?.dedupedFrom, "t1");
});

test("tools: a read-only tool retries once, a write tool never does", async () => {
  let reads = 0;
  const flakyRead = tool({
    name: "FlakyRead",
    retries: 1,
    async call() {
      reads++;
      if (reads === 1) return { content: "boom", isError: true };
      return { content: "second time lucky" };
    },
  });
  const r1 = await executeCall(
    prepareCall({ get: () => flakyRead, names: () => ["FlakyRead"] }, { id: "1", name: "FlakyRead", input: {} }),
    ctx(),
  );
  assert.equal(r1.isError, undefined);
  assert.equal(reads, 2);
  assert.equal((r1.metadata as { retriedAfterError?: number })?.retriedAfterError, 1);

  let writes = 0;
  const flakyWrite = tool({
    name: "FlakyWrite",
    isReadOnly: false,
    isConcurrencySafe: () => false,
    retries: 1,
    async call() {
      writes++;
      return { content: "nope", isError: true };
    },
  });
  const r2 = await executeCall(
    prepareCall({ get: () => flakyWrite, names: () => ["FlakyWrite"] }, { id: "2", name: "FlakyWrite", input: {} }),
    ctx(),
  );
  assert.equal(r2.isError, true);
  assert.equal(writes, 1, "writes must never be retried automatically");
});

test("tools: schema constraints cover enum, length, range and array items", () => {
  const schema = {
    type: "object" as const,
    properties: {
      mode: { type: "string", enum: ["fast", "safe"] },
      name: { type: "string", minLength: 3, maxLength: 5 },
      n: { type: "integer", minimum: 1, maximum: 10 },
      tags: { type: "array", items: { type: "string" } },
      slug: { type: "string", pattern: "^[a-z]+$" },
    },
  };
  assert.match(validateAgainstSchema(schema, { mode: "turbo" }) ?? "", /must be one of/);
  assert.match(validateAgainstSchema(schema, { name: "ab" }) ?? "", /at least 3/);
  assert.match(validateAgainstSchema(schema, { name: "abcdef" }) ?? "", /at most 5/);
  assert.match(validateAgainstSchema(schema, { n: 1.5 }) ?? "", /integer/);
  assert.match(validateAgainstSchema(schema, { n: 11 }) ?? "", /<= 10/);
  assert.match(validateAgainstSchema(schema, { tags: ["a", 2] }) ?? "", /tags\[1\] must be of type string/);
  assert.match(validateAgainstSchema(schema, { slug: "NOPE" }) ?? "", /does not match pattern/);
  assert.equal(validateAgainstSchema(schema, { mode: "fast", name: "abcd", n: 5, tags: ["a"], slug: "ok" }), null);
});

test("tools: per-tool stats count calls and failures separately", async () => {
  const { Session } = await import("../src/core/session.ts");
  const { MockProvider } = await import("../src/providers/mock.ts");
  const { mkdtempSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = mkdtempSync(path.join(os.tmpdir(), "jys-stats-"));
  const session = new Session({
    workspaceRoot: root,
    settings: { permissionMode: "bypassPermissions", sandboxMode: "danger-full-access", maxTurns: 4, maxTokens: 256 },
    rules: emptyRuleSet(),
    provider: new MockProvider([
      { text: "a", toolCalls: [{ name: "Read", input: { file_path: "nope.md" } }] },
      { text: "b", toolCalls: [{ name: "Read", input: { file_path: "nope.md" } }] },
      { text: "done" },
    ]),
    model: "mock-1",
    logger,
    approve: async () => "allow",
    enableSubagent: false,
  });
  await session.init();
  for await (const _ev of session.send("go", new AbortController().signal)) { /* drain */ }
  const bucket = session.stats.toolStats?.Read;
  assert.ok(bucket, JSON.stringify(session.stats.toolStats));
  assert.equal(bucket.calls, 2);
  assert.equal(bucket.errors, 2, "reading a missing file is an error and must be counted");
});

test("tools: nested object schemas validate recursively with a path", () => {
  const schema = {
    type: "object" as const,
    properties: {
      opts: {
        type: "object",
        properties: {
          level: { type: "integer", minimum: 1, maximum: 5 },
          tags: { type: "array", items: { type: "string", minLength: 2 } },
        },
        required: ["level"],
        additionalProperties: false,
      },
    },
    required: ["opts"],
  };
  assert.equal(validateAgainstSchema(schema, { opts: { level: 3 } }), null);
  assert.match(validateAgainstSchema(schema, { opts: { level: 9 } }) ?? "", /opts\.level must be <= 5/);
  assert.match(validateAgainstSchema(schema, { opts: {} }) ?? "", /opts is missing required property: level/);
  assert.match(validateAgainstSchema(schema, { opts: { level: 1, bogus: 1 } }) ?? "", /opts has unexpected property: bogus/);
  assert.match(validateAgainstSchema(schema, { opts: { level: 1, tags: ["a"] } }) ?? "", /opts\.tags\[0\] must be at least 2/);
});

test("breaker: three consecutive failures pause the tool, a success resets it", () => {
  const health = new ToolHealth();
  const now = 1_000_000;
  health.record("Read", true, now);
  health.record("Read", true, now);
  assert.equal(health.check("Read", now), null, "two failures are not enough");
  health.record("Read", true, now);
  const blocked = health.check("Read", now);
  assert.ok(blocked && /paused for 60s/.test(blocked), blocked ?? "not blocked");
  assert.deepEqual(Object.keys(health.open(now)), ["Read"]);
  assert.equal(health.check("Read", now + BREAKER_COOLDOWN_MS + 1), null);
  assert.deepEqual(Object.keys(health.open(now + BREAKER_COOLDOWN_MS + 1)), []);

  health.record("Bash", true, now);
  health.record("Bash", true, now);
  health.record("Bash", false, now);
  health.record("Bash", true, now);
  assert.equal(health.check("Bash", now), null, "a success in between must reset the streak");
});

test("breaker: a failing tool is short-circuited inside the real loop", async () => {
  const { queryLoop } = await import("../src/core/query.ts");
  let calls = 0;
  const broken = tool({
    name: "Broken",
    async call() {
      calls++;
      return { content: "always fails", isError: true };
    },
  });
  const provider = {
    id: "f",
    model: "f",
    turns: 0,
    async *stream() {
      this.turns++;
      if (this.turns <= 5) {
        yield {
          type: "done" as const,
          message: {
            role: "assistant" as const,
            content: [{ type: "tool_use", id: "t" + this.turns, name: "Broken", input: {} }],
            stopReason: "tool_use",
          },
        };
      } else {
        yield { type: "done" as const, message: { role: "assistant" as const, content: [{ type: "text", text: "ok" }], stopReason: "end_turn" } };
      }
    },
  };
  const health = new ToolHealth();
  const events: any[] = [];
  const it = queryLoop({
    provider: provider as never,
    model: "f",
    systemPrompt: "s",
    messages: [{ role: "user", content: [{ type: "text", text: "try" }] }],
    tools: [broken],
    preloadedToolMap: new Map([["Broken", broken]]),
    permission: { mode: "bypassPermissions", rules: emptyRuleSet(), sandboxMode: "danger-full-access", workspaceRoot: process.cwd() },
    toolContext: ctx(),
    hooks: {},
    logger,
    sessionId: "breaker",
    maxTurns: 8,
    maxTokens: 100,
    toolHealth: health,
    signal: new AbortController().signal,
    approve: async () => "allow",
  } as never);
  for (;;) {
    const r = await it.next();
    if (r.done) break;
    events.push(r.value);
  }
  assert.equal(calls, 3, "only three real attempts, the rest are short-circuited");
  const ends = events.filter((e) => e.type === "tool_end");
  assert.ok(ends.length >= 4);
  assert.match(String(ends[ends.length - 1].result.content), /paused for/);
});

test("mcp: a dead server is restarted once and the call is retried", async () => {
  const { callWithReconnect } = await import("../src/mcp/tools.ts");
  let alive = false;
  let restarts = 0;
  let attempts = 0;
  const result = await callWithReconnect({
    call: async () => {
      attempts++;
      if (!alive) throw new Error("MCP server x exited");
      return "ok";
    },
    alive: () => alive,
    restart: async () => {
      restarts++;
      alive = true;
    },
  });
  assert.equal(result, "ok");
  assert.equal(restarts, 1);
  assert.equal(attempts, 2);
});

test("mcp: a live server's error is surfaced, not restarted", async () => {
  const { callWithReconnect } = await import("../src/mcp/tools.ts");
  let restarts = 0;
  await assert.rejects(
    callWithReconnect({
      call: async () => {
        throw new Error("tool returned an error");
      },
      alive: () => true,
      restart: async () => {
        restarts++;
      },
    }),
    /tool returned an error/,
  );
  assert.equal(restarts, 0);
});

test("read cache: identical reads hit the cache, edits invalidate it", async () => {
  const { ReadTool } = await import("../src/tools/fsTools.ts");
  const { clearReadCache, readCacheStats } = await import("../src/util/readCache.ts");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const os2 = await import("node:os");
  const path2 = await import("node:path");
  clearReadCache();
  const root = mkdtempSync(path2.join(os2.tmpdir(), "jys-rc-"));
  const file = path2.join(root, "a.ts");
  writeFileSync(file, "line1" + String.fromCharCode(10) + "line2", "utf8");
  const c = ctx({ workspaceRoot: root, cwd: root });

  const first = await ReadTool.call({ file_path: file }, c);
  assert.equal(first.metadata?.cached, undefined, "first read must be a miss");
  assert.equal(readCacheStats().entries, 1);

  const second = await ReadTool.call({ file_path: file }, c);
  assert.equal(second.metadata?.cached, true, "second read must hit");
  assert.equal(second.content, first.content);

  // 不同的窗口是不同的缓存项
  await ReadTool.call({ file_path: file, offset: 2, limit: 1 }, c);
  assert.equal(readCacheStats().entries, 2);

  // 改文件 -> 失效
  writeFileSync(file, "line1" + String.fromCharCode(10) + "CHANGED", "utf8");
  const third = await ReadTool.call({ file_path: file }, c);
  assert.equal(third.metadata?.cached, undefined, "edited file must be re-read");
  assert.ok(third.content.includes("CHANGED"));
  clearReadCache();
});

test("read cache: eviction keeps the cache bounded", async () => {
  const { clearReadCache, lookupRead, readCacheStats, storeRead } = await import("../src/util/readCache.ts");
  clearReadCache();
  for (let i = 0; i < 40; i++) {
    storeRead({ path: "f" + i, offset: 1, limit: 10, mtimeMs: i, size: 10, total: 10, content: "x".repeat(1000) });
  }
  assert.ok(readCacheStats().entries <= 32, "entries capped: " + readCacheStats().entries);
  assert.equal(lookupRead("f0", 1, 10, 0, 10), null, "oldest entry evicted");
  assert.ok(lookupRead("f39", 1, 10, 39, 10), "newest entry kept");
  clearReadCache();
});
