/** `jys worktree …`：列出/预检/合并并行任务的工作树。 */
import path from "node:path";
import { createWorktree, listWorktrees, mainRepositoryRoot, removeWorktree } from "../core/worktrees.ts";
import { currentBranch, mergeBranches, mergeBranchesAsync, preflightAll } from "../core/worktreeMerge.ts";
import { conflictedFiles, linkDependencies, rebaseWorktree, runVerify, verifyBranches, withRepoLock } from "../core/worktreeOps.ts";
import { SessionStore } from "../session/store.ts";
import { existsSync, readdirSync } from "node:fs";

const NL = String.fromCharCode(10);

function usage(): string {
  return [
    "jys worktree list              列出工作树与分支",
    "jys worktree create <name> [--base <rev>]   建一个任务工作树（分支 jys/<name>）",
    "jys worktree preflight <b1> <b2> …  [--into <br>]   按顺序推演，报告会不会冲突",
    "jys worktree merge <b1> <b2> …      [--into <br>] [--no-ff]   依次合并，冲突即停并回滚",
    "jys worktree verify <b1> … --cmd \"npm test\"   在每个任务工作树里跑验证",
    "jys worktree link <name>                      把主仓库依赖(junction)链进工作树，省磁盘",
    "jys worktree rebase <name> [--onto main]      把任务分支 rebase 到目标分支（base 漂移）",
    "jys worktree conflicts                        列出当前未解决的冲突文件",
    "jys worktree merge … --resolve-with-agent     冲突交给 agent 解决（解完需过 --verify 才提交）",
    "jys worktree remove <path> [--force]          删工作树",
  ].join(NL);
}

export async function runWorktree(argv: string[], workspace: string): Promise<number> {
  const repoRoot = await mainRepositoryRoot(workspace);
  if (!repoRoot) {
    console.error("当前目录不在 git 仓库里：" + workspace);
    return 2;
  }
  // 同 runSkill：跳过前置 flag（jys --workspace X worktree list）
  const action = argv.find((x, i) => !x.startsWith("--") && !String(argv[i - 1] ?? "").startsWith("--")) ?? "list";
  const rest = argv.slice(1);
  const flag = (name: string) => {
    const i = rest.indexOf("--" + name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const positional = rest.filter((x, i) => !x.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--")));

  if (action === "list") {
    const items = await listWorktrees(repoRoot);
    for (const w of items) {
      const dirty = w.dirty ? " [未提交 " + w.dirty + " 项]" : "";
      console.log((w.isMain ? "* " : "  ") + w.branch.padEnd(24) + " " + w.path + dirty);
    }
    console.log("");
    console.log("主仓库：" + repoRoot + "（当前分支 " + (currentBranch(repoRoot) ?? "分离 HEAD") + "）");
    return 0;
  }

  if (action === "create") {
    const name = positional[0];
    if (!name) { console.log(usage()); return 2; }
    const res = await createWorktree(repoRoot, name, flag("base"));
    if (!res.ok) { console.error("创建失败：" + res.error); return 1; }
    console.log("已创建 " + res.branch + " → " + res.path);
    if (res.copied.length) console.log("已复制本地配置：" + res.copied.join(", "));
    return 0;
  }

  if (action === "preflight" || action === "merge") {
    const branches = positional;
    if (!branches.length) { console.log(usage()); return 2; }
    const into = flag("into") ?? currentBranch(repoRoot) ?? undefined;
    if (!into) { console.error("无法确定目标分支，请用 --into 指定"); return 2; }

    const plan = preflightAll(repoRoot, into, branches);
    console.log("合并计划（目标 " + into + "）：");
    for (const p of plan) {
      const tag = p.alreadyMerged ? "已合并，跳过" : p.conflicts ? "冲突：" + p.files.join(", ") : "可以干净合并";
      console.log("  " + p.branch.padEnd(24) + tag);
    }
    if (action === "preflight") return plan.some((p) => p.conflicts) ? 1 : 0;

    const blocked = plan.find((p) => p.conflicts);
    if (blocked) {
      console.log(NL + "预检发现冲突，未执行合并（仓库未被改动）。冲突文件：" + blocked.files.join(", "));
      return 1;
    }
    // 合并前验证：只合并不跑测试等于把回归直接合进主干。
    // 顺序是"先验后合"：任一分支验证失败就不合（--force-merge 可跳过）。
    const verifyCmd = flag("verify");
    if (verifyCmd && !rest.includes("--force-merge")) {
      console.log(NL + "合并前验证（" + verifyCmd + "）：");
      const verified = await verifyBranches(repoRoot, branches, verifyCmd);
      let bad = 0;
      for (const v of verified) {
        if (!v.ok) bad++;
        console.log("  " + (v.ok ? "PASS " : "FAIL ") + v.target.padEnd(26) + (v.ok ? "" : " — " + v.tail.split("\n").slice(-3).join(" ")));
      }
      if (bad) {
        console.error(NL + bad + " 个分支验证失败，已放弃合并（加 --force-merge 可强制合并）");
        return 1;
      }
    }

    const useAgent = rest.includes("--resolve-with-agent");
    // 会写 git 元数据（index/refs），必须持锁执行，避免与别的任务并发撞 index.lock。
    // 开了 --resolve-with-agent 就走异步编排（agent 是异步的，不能塞进同步钩子）。
    const locked = await withRepoLock(repoRoot, () =>
      useAgent
        ? mergeBranchesAsync(repoRoot, {
            into,
            branches,
            noFf: rest.includes("--no-ff"),
            resolver: async ({ branch: conflictedBranch, files }) => {
              console.log(NL + "冲突：" + files.join(", ") + " → 交给 agent 解决");
              const { resolveConflictsWithAgent } = await import("./worktreeResolve.ts");
              return resolveConflictsWithAgent(repoRoot, conflictedBranch, { verify: verifyCmd, verbose: false });
            },
          })
        : mergeBranches(repoRoot, { into, branches, noFf: rest.includes("--no-ff") }),
    );
    if (!locked.ok) { console.error("拿不到仓库锁：" + locked.error); return 1; }
    const res = locked.value;
    if (!res.ok) { console.error("合并失败：" + (res.error ?? "")); if (res.blocked) console.error("冲突：" + res.blocked.files.join(", ")); return 1; }
    console.log(NL + "已合并 " + res.merged.length + " 个分支到 " + res.into + "：" + (res.merged.join(", ") || "(无需合并)"));

    // 合并后复验：逐树通过不等于合起来通过（语义冲突、接口不兼容都只在合并后暴露）
    if (verifyCmd) {
      console.log(NL + "合并后复验（" + verifyCmd + "）：");
      const after = await runVerify(repoRoot, verifyCmd);
      console.log("  " + (after.ok ? "PASS " : "FAIL ") + res.into + (after.ok ? "" : "\n" + after.tail.split("\n").slice(-8).map((l) => "        " + l).join("\n")));
      if (!after.ok) {
        console.error("合并后验证失败：改动已在本地分支上，可用 git reset --hard ORIG_HEAD 回退");
        return 1;
      }
    }
    return 0;
  }


  if (action === "verify") {
    const cmd = flag("cmd");
    if (!cmd || !positional.length) { console.log(usage()); return 2; }
    console.log("在工作树里跑：" + cmd);
    const results = await verifyBranches(repoRoot, positional, cmd);
    let bad = 0;
    for (const r of results) {
      if (!r.ok) bad++;
      console.log("  " + (r.ok ? "PASS " : "FAIL ") + r.target.padEnd(26) + String(r.ms + "ms").padStart(7) + (r.ok ? "" : "\n" + r.tail.split("\n").slice(-6).map((l) => "        " + l).join("\n")));
    }
    return bad ? 1 : 0;
  }

  if (action === "link") {
    const name = positional[0];
    if (!name) { console.log(usage()); return 2; }
    const items = await listWorktrees(repoRoot);
    const target = items.find((w) => w.branch === "jys/" + name || w.path.endsWith(path.sep + name));
    if (!target) { console.error("找不到工作树：" + name); return 1; }
    const linked = linkDependencies(repoRoot, target.path);
    for (const l of linked) console.log("  " + l.name.padEnd(16) + l.status + (l.detail ? "  " + l.detail : ""));
    const bad = linked.some((l) => l.status === "error");
    return bad ? 1 : 0;
  }

  if (action === "rebase") {
    const name = positional[0];
    if (!name) { console.log(usage()); return 2; }
    const onto = flag("onto") ?? currentBranch(repoRoot) ?? "main";
    const items = await listWorktrees(repoRoot);
    const target = items.find((w) => w.branch === (name.startsWith("jys/") ? name : "jys/" + name) || w.path.endsWith(path.sep + name));
    if (!target) { console.error("找不到工作树：" + name); return 1; }
    const res = await withRepoLock(repoRoot, () => rebaseWorktree(target.path, onto));
    if (!res.ok) { console.error("拿不到仓库锁：" + res.error); return 1; }
    const r = res.value;
    if (!r.ok) {
      console.error("rebase 失败：" + r.detail);
      if (r.files.length) console.error("冲突文件：" + r.files.join(", "));
      return 1;
    }
    console.log(target.branch + " 已 rebase 到 " + onto);
    return 0;
  }

  if (action === "conflicts") {
    const files = conflictedFiles(repoRoot);
    if (!files.length) { console.log("没有未解决的冲突"); return 0; }
    for (const f of files) console.log("  " + f);
    return 1;
  }
  if (action === "remove") {
    const target = positional[0];
    if (!target) { console.log(usage()); return 2; }
    const res = await removeWorktree(repoRoot, path.resolve(workspace, target), rest.includes("--force"));
    if (!res.ok) { console.error("删除失败：" + res.error); return 1; }
    console.log("已删除 " + target);
    return 0;
  }

  if (action === "sessions") {
    // 每个工作树独立会话：列出各自最近的转录，确认隔离真的生效
    const items = await listWorktrees(repoRoot);
    for (const w of items) {
      const store = new SessionStore(path.join(w.path, ".harness", "sessions"));
      const ids = await store.ids();
      console.log(w.branch.padEnd(24) + ids.length + " 个会话" + (ids.length ? "（最新 " + ids[ids.length - 1] + "）" : ""));
    }
    return 0;
  }

  console.log(usage());
  return 2;
}

void existsSync;
void readdirSync;
