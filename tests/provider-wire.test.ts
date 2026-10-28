import { test } from "node:test";
import assert from "node:assert/strict";
import { toWire } from "../src/providers/anthropic.ts";
import { textBlock, toolResultMessage, userMessage } from "../src/core/types.ts";

const asst = (blocks: any[]) => ({ role: "assistant", content: blocks, stopReason: "end_turn" });

test("anthropic wire: consecutive user messages are merged", () => {
  const msgs: any[] = [
    userMessage("do it"),
    asst([
      { type: "text", text: "running" },
      { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "a" } },
    ]),
    toolResultMessage([{ type: "tool_result", tool_use_id: "tu1", content: "data" }]),
    userMessage("hook blocked completion", true),
  ];
  const wire = toWire(msgs);
  assert.equal(wire.length, 3, JSON.stringify(wire.map((m) => m.role)));
  assert.deepEqual(wire.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(wire[2].content.length, 2, "tool_result 与后续提示合并成一条");
});

test("anthropic wire: roles always alternate", () => {
  const msgs: any[] = [
    userMessage("a"),
    userMessage("b"),
    asst([textBlock("x")]),
    userMessage("c"),
    userMessage("d"),
  ];
  const wire = toWire(msgs);
  for (let i = 1; i < wire.length; i++) {
    assert.notEqual(wire[i].role, wire[i - 1].role, "相邻消息角色重复: " + JSON.stringify(wire.map((m) => m.role)));
  }
});

test("anthropic wire: leading assistant is dropped and empty content skipped", () => {
  const msgs: any[] = [asst([textBlock("stray")]), userMessage("real")];
  const wire = toWire(msgs);
  assert.equal(wire.length, 1);
  assert.equal(wire[0].role, "user");
});

test("anthropic wire: an interrupted tool call still gets a result block", () => {
  // 用户中断后，transcript 里会留下"有 tool_use、没有 tool_result"的助手消息。
  // 直接发出去就是 400，所以线格式层必须补一条占位结果。
  const msgs: any[] = [
    userMessage("run it"),
    asst([{ type: "tool_use", id: "tu9", name: "Bash", input: { command: "ls" } }]),
    userMessage("never mind, do something else"),
  ];
  const wire = toWire(msgs);
  const userTurn = wire[wire.length - 1];
  const results = (userTurn.content as any[]).filter((b) => b.type === "tool_result");
  assert.equal(results.length, 1, "missing tool_result must be synthesised");
  assert.equal(results[0].tool_use_id, "tu9");
  assert.equal(results[0].is_error, true);
});

test("anthropic wire: an answered tool call is not double-filled", () => {
  const msgs: any[] = [
    userMessage("run it"),
    asst([{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }]),
    toolResultMessage([{ type: "tool_result", tool_use_id: "tu1", content: "ok" }]),
  ];
  const wire = toWire(msgs);
  const results = (wire[wire.length - 1].content as any[]).filter((b) => b.type === "tool_result");
  assert.equal(results.length, 1);
  assert.equal(results[0].content, "ok");
});

test("anthropic wire: a non-text/non-tool_use block never becomes a malformed tool_use", () => {
  // 以前这里用三元 + 强转，任何"既不是 text 也不是 tool_use"的块都会被拼成
  // { type: "tool_use", id: undefined, name: undefined } —— 直接 400，而强转掩盖了它。
  const msgs: any[] = [
    userMessage("look"),
    asst([
      { type: "text", text: "here" },
      { type: "image", mediaType: "image/png", data: "AAA" },
      { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "a" } },
    ]),
  ];
  const wire = toWire(msgs);
  const assistant = wire.find((m) => m.role === "assistant")!;
  const blocks = assistant.content as { type: string; id?: unknown; name?: unknown }[];
  assert.deepEqual(blocks.map((b) => b.type), ["text", "tool_use"], "only valid blocks survive");
  const toolUse = blocks.find((b) => b.type === "tool_use")!;
  assert.equal(toolUse.id, "tu1");
  assert.equal(toolUse.name, "Read");
  assert.ok(blocks.every((b) => b.type !== "tool_use" || typeof b.id === "string"));
});
