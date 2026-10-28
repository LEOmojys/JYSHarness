import { test } from "node:test";
import assert from "node:assert/strict";
import { mapWithLimit, stableKey } from "../src/util/async.ts";

test("async: mapWithLimit bounds concurrency but keeps result order", async () => {
  let active = 0;
  let peak = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);
  const out = await mapWithLimit(items, 3, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5 + (n % 3)));
    active--;
    return n * 2;
  });
  assert.deepEqual(out, items.map((n) => n * 2), "results must line up with inputs");
  assert.ok(peak <= 3, "concurrency must stay within the limit: peak=" + peak);
  assert.ok(peak >= 2, "the limit must actually be used (not serialised)");
});

test("async: mapWithLimit handles empty input and a limit larger than the batch", async () => {
  assert.deepEqual(await mapWithLimit([], 4, async () => 1), []);
  const out = await mapWithLimit([1, 2], 99, async (n) => n + 1);
  assert.deepEqual(out, [2, 3]);
});

test("async: mapWithLimit propagates the first failure", async () => {
  await assert.rejects(
    () =>
      mapWithLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    /boom/,
  );
});

test("async: stableKey ignores key order and is stable for equal payloads", () => {
  assert.equal(stableKey({ b: 1, a: 2 }), stableKey({ a: 2, b: 1 }));
  assert.notEqual(stableKey({ a: 1 }), stableKey({ a: 2 }));
  // 嵌套也要排序，否则同一份 input 换个写法就被当成两次调用
  assert.equal(stableKey({ x: { d: 1, c: 2 } }), stableKey({ x: { c: 2, d: 1 } }));
  // 数组顺序是有意义的，不能排序
  assert.notEqual(stableKey([1, 2]), stableKey([2, 1]));
  assert.equal(stableKey(null), "null");
});
