import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SweInstance } from "./swebench.ts";

type Instance = Pick<SweInstance, "instance_id" | "repo" | "base_commit">;
type Outcome = { ok: boolean; detail: string };

const marker = "harness-swe-instance";
const sourcePaths = [".", ":(exclude).venv", ":(exclude).harness",
  ":(exclude,glob)**/tests/**", ":(exclude,glob)**/testing/**"];

function git(dir: string, args: string[], env = process.env) {
  // Explicit paths prevent Git from discovering the harness repository above an instance directory.
  return spawnSync("git", ["--git-dir=" + path.join(dir, ".git"), "--work-tree=" + dir, ...args], {
    cwd: dir, env, encoding: "utf8", timeout: 900_000, maxBuffer: 64 * 1024 * 1024,
  });
}

type CommandResult = ReturnType<typeof git>;
const failure = (r: CommandResult) => r.error?.message ?? (r.stderr || "git failed").trim().slice(-300);
const owner = (inst: Instance) => JSON.stringify([inst.instance_id, inst.repo, inst.base_commit]);

function checkLocation(dir: string, inst: Instance): void {
  if (!path.isAbsolute(dir) || path.basename(dir) !== inst.instance_id ||
      !/^[\w-][\w.-]*$/.test(inst.instance_id) || !/^[\w.-]+\/[\w.-]+$/.test(inst.repo) ||
      !/^[a-f\d]{40}$/i.test(inst.base_commit)) throw new Error("Invalid SWE instance location or Git revision");
  const location = lstatSync(dir, { throwIfNoEntry: false });
  if (location && !location.isDirectory()) throw new Error("Invalid SWE instance directory");
}

function requireOwner(dir: string, inst: Instance): void {
  checkLocation(dir, inst);
  const gitDir = path.join(dir, ".git");
  const file = path.join(gitDir, marker);
  if (!lstatSync(gitDir, { throwIfNoEntry: false })?.isDirectory() ||
      !lstatSync(file, { throwIfNoEntry: false })?.isFile() || readFileSync(file, "utf8") !== owner(inst)) {
    throw new Error("Unrecognized SWE instance workspace. Use --workdir=<empty-directory> to preserve existing files.");
  }
}

function restore(dir: string, inst: Instance, preparing: boolean): Outcome {
  requireOwner(dir, inst);
  const checkout = git(dir, ["checkout", "--detach", "--force", "-q", inst.base_commit]);
  if (checkout.status !== 0) return { ok: false, detail: failure(checkout) };
  // An old grading patch or session must never be visible to the next model. Keep the installed venv.
  const clean = git(dir, preparing ? ["clean", "-ffdxq", "-e", "/.venv/"] : ["clean", "-ffdq", "-e", "/.venv/", "-e", "/.harness/"]);
  return clean.status === 0 ? { ok: true, detail: "reset" } : { ok: false, detail: failure(clean) };
}

/** Fetch the immutable base on first use and reuse only a checkout created for this exact instance. */
export function prepareRepo(dir: string, inst: Instance): Outcome {
  try {
    checkLocation(dir, inst);
    mkdirSync(dir, { recursive: true });
    if (!readdirSync(dir).length) {
      const init = git(dir, ["init", "-q"]);
      if (init.status !== 0) return { ok: false, detail: failure(init) };
      writeFileSync(path.join(dir, ".git", marker), owner(inst), { flag: "wx" });
      const remote = git(dir, ["remote", "add", "origin", "https://github.com/" + inst.repo]);
      if (remote.status !== 0) return { ok: false, detail: failure(remote) };
    }
    requireOwner(dir, inst);
    if (git(dir, ["cat-file", "-e", inst.base_commit + "^{commit}"]).status !== 0) {
      const fetch = git(dir, ["fetch", "-q", "--depth", "1", "https://github.com/" + inst.repo, inst.base_commit]);
      if (fetch.status !== 0) return { ok: false, detail: failure(fetch) };
    }
    return restore(dir, inst, true);
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Snapshot the final source tree, including additions, without changing the model's staging area. */
export function extractPatch(dir: string, inst: Instance): string {
  requireOwner(dir, inst);
  const gitDir = path.join(dir, ".git");
  const temp = mkdtempSync(path.join(gitDir, "swe-index-"));
  try {
    const index = path.join(temp, "index");
    if (existsSync(path.join(gitDir, "index"))) copyFileSync(path.join(gitDir, "index"), index);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    const add = git(dir, ["add", "-A", "--", ...sourcePaths], env);
    if (add.status !== 0) throw new Error(failure(add));
    const diff = git(dir, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", inst.base_commit, "--", ...sourcePaths], env);
    if (diff.status !== 0) throw new Error(failure(diff));
    return diff.stdout;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function resetToBase(dir: string, inst: Instance): Outcome {
  try {
    return restore(dir, inst, false);
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
