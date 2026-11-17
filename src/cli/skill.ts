/**
 * `jys skill …`：列出/导入技能。
 *
 * 重点是 DSH 兼容：DSH 的技能是**扁平 `*.md` + frontmatter**（name/description/whenToUse/role/enabled），
 * 而 JYSHarness 的技能发现本来就认扁平 .md，所以两者在格式上天然兼容 ——
 * 缺的只是一个"把它们放到位"的命令，而不是转换器。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { configHome } from "../core/configStore.ts";
import { discoverSkillsWithWarnings } from "../core/skills.ts";

const NL = String.fromCharCode(10);

function usage(): string {
  return [
    "jys skill list [--json]                     列出当前工作区能看到的技能",
    "jys skill import-dsh <dir> [--to project|user]  导入 DSH 格式的技能目录（扁平 *.md）",
  ].join(NL);
}

export async function runSkill(argv: string[], workspace: string): Promise<number> {
  // 跳过前置 flag：调用方可能写成 jys --workspace X skill list，此时 argv[0] 是 --workspace
  const action = argv.find((x, i) => !x.startsWith("--") && !String(argv[i - 1] ?? "").startsWith("--")) ?? "list";
  const rest = argv.slice(1);
  const flag = (name: string) => {
    const i = rest.indexOf("--" + name);
    return i >= 0 ? rest[i + 1] : undefined;
  };

  if (action === "list") {
    const res = discoverSkillsWithWarnings(workspace);
    if (rest.includes("--json")) {
      console.log(JSON.stringify({ skills: res.skills.map((s) => ({ name: s.name, description: s.description, source: s.source, dir: s.dir })), warnings: res.warnings }, null, 2));
      return 0;
    }
    console.log("工作区：" + workspace);
    for (const s of res.skills) {
      console.log("  " + s.name.padEnd(24) + "[" + s.source + "] " + s.description.slice(0, 60));
    }
    console.log(NL + "共 " + res.skills.length + " 个技能" + (res.warnings.length ? "，" + res.warnings.length + " 条提示" : ""));
    for (const w of res.warnings) console.log("  ! " + w);
    return 0;
  }

  if (action === "import-dsh") {
    // 位置参数 = 动作之后、且不是某个 flag 的值（--to project 里的 project 不算）
    // rest 已经是"去掉动作名"后的参数，不能再切一次（切了会把目录吞掉）
    const positional = rest.filter((x, i, arr) => !x.startsWith("--") && arr[i - 1] !== "--to");
    const src = positional[0];
    if (!src) { console.log(usage()); return 2; }
    const to = flag("to") === "user" ? "user" : "project";
    const target = to === "user" ? path.join(configHome(), "skills") : path.join(workspace, ".harness", "skills");
    if (!existsSync(src) || !statSync(src).isDirectory()) {
      console.error("不是目录：" + src);
      return 2;
    }
    mkdirSync(target, { recursive: true });

    let copied = 0;
    let skipped = 0;
    const files = readdirSync(src).filter((f) => f.toLowerCase().endsWith(".md"));
    for (const f of files) {
      const from = path.join(src, f);
      const dest = path.join(target, f);
      // 幂等：已存在就跳过，不覆盖用户改过的版本
      if (existsSync(dest)) {
        skipped++;
        continue;
      }
      copyFileSync(from, dest);
      copied++;
    }

    const after = discoverSkillsWithWarnings(workspace);
    console.log("从 " + src + " 导入到 " + target);
    console.log("  复制 " + copied + " 个，跳过 " + skipped + " 个已存在");
    console.log("  当前可见技能：" + after.skills.length + " 个" + (to === "user" ? "（用户级，对所有项目生效）" : "（项目级）"));
    return 0;
  }

  console.log(usage());
  return 2;
}
