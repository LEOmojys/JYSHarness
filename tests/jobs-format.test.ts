import test from "node:test";
import assert from "node:assert/strict";
import { formatJob } from "../src/core/jobs.ts";

// formatJob 是给 UI/CLI 展示任务状态的格式化函数，之前没有任何调用方（dead export）。
// 这里把它锁住：状态、退出码、尾部输出都要出现，否则用户看不到任务为什么失败。
test("jobs: formatJob renders status, exit code and the tail of the output", () => {
  const text = formatJob({
    id: "job-1",
    kind: "bash",
    label: "npm test",
    status: "failed",
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_003_000,
    output: "line-1\nline-2\nboom: assertion failed",
    exitCode: 1,
  } as never);
  assert.match(text, /job-1/, "要能看到任务 id");
  assert.match(text, /failed/, "要能看到状态");
  assert.match(text, /boom: assertion failed/, "要能看到输出尾部（失败原因）");
});
