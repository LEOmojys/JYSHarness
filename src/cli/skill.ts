/**
 * `jys skill …`：列出/导入技能。
 *
 * 重点是 DSH 兼容：DSH 的技能是**扁平 `*.md` + frontmatter**（name/description/whenToUse/role/enabled），
 * 而 JYSHarness 的技能发现本来就认扁平 .md，所以两者在格式上天然兼容 ——
 * 缺的只是一个"把它们放到位"的命令，而不是转换器。
 */
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
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
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: {
      json: { type: "boolean" }, to: { type: "string" }, help: { type: "boolean", short: "h" },
    } });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const { values, positionals } = parsed;
  const [action = "list", src] = positionals;
  if (values.help) { console.log(usage()); return 0; }

  if (action === "list") {
    if (src !== undefined || values.to !== undefined) { console.error(usage()); return 2; }
    const res = discoverSkillsWithWarnings(workspace);
    if (values.json) {
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
    const to = values.to ?? "project";
    if (!src || positionals.length !== 2 || values.json || (to !== "user" && to !== "project")) {
      console.error(usage());
      return 2;
    }
    const target = to === "user" ? path.join(configHome(), "skills") : path.join(workspace, ".harness", "skills");
    if (!existsSync(src) || !statSync(src).isDirectory()) {
      console.error("不是目录：" + src);
      return 2;
    }
    mkdirSync(target, { recursive: true });

    let copied = 0;
    let skipped = 0;
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      try {
        copyFileSync(path.join(src, entry.name), path.join(target, entry.name), constants.COPYFILE_EXCL);
        copied++;
      } catch (err) {
        if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
        skipped++;
      }
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
