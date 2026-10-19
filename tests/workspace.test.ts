import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Session } from "../src/core/session.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { emptyRuleSet } from "../src/permissions/rules.ts";
import { Logger } from "../src/util/log.ts";
import { startServer } from "../src/server/app.ts";
import {
  browseDirectories,
  detectWorkspaceKind,
  listFavoriteEntries,
  listRecentEntries,
  listRecentWorkspaces,
  rememberWorkspace,
  setFavorite,
  validateWorkspace,
} from "../src/core/workspaces.ts";

const logger = new Logger("error");

/** 服务端统一用 realpath 规范化，测试也要用长路径比较（Windows 8.3 短路径）。 */
const real = (p: string) => realpathSync.native(p);

async function tempDir(prefix = "mh-ws-"): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = await tempDir("mh-home-");
  const prev = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = home;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = prev;
  }
}

function makeSession(root: string): Session {
  return new Session({
    workspaceRoot: root,
    settings: { permissionMode: "default", sandboxMode: "workspace-write", maxTurns: 4 },
    rules: emptyRuleSet(),
    provider: new MockProvider([{ text: "ok", stopReason: "end_turn" }]),
    model: "mock-1",
    logger,
    approve: async () => "allow",
  });
}

test("workspace: validation rejects missing paths and files", async () => {
  const dir = await tempDir();
  assert.equal(validateWorkspace(dir).ok, true);
  assert.equal(validateWorkspace(path.join(dir, "nope")).ok, false);
  const file = path.join(dir, "a.txt");
  await writeFile(file, "x", "utf8");
  const asFile = validateWorkspace(file);
  assert.equal(asFile.ok, false);
  assert.match(asFile.error!, /不是目录/);
  assert.equal(validateWorkspace("").ok, false);
});

test("workspace: recent list de-duplicates and caps its size", async () => {
  await withHome(async () => {
    const a = await tempDir();
    const b = await tempDir();
    rememberWorkspace(a);
    rememberWorkspace(b);
    rememberWorkspace(a);
    const recent = listRecentWorkspaces();
    assert.equal(real(recent[0]), real(a), "most recent first");
    assert.equal(recent.length, 2, "no duplicates");

    const entries = listRecentEntries();
    assert.equal(entries.length, 2);
    assert.ok(entries[0].at >= entries[1].at, "按打开时间倒序");
    assert.equal(entries[0].favorite, false);
  });
});

test("workspace: browse lists directories only", async () => {
  const dir = await tempDir();
  await mkdir(path.join(dir, "sub"));
  await writeFile(path.join(dir, "file.txt"), "x", "utf8");
  const result = browseDirectories(dir);
  const names = result.dirs.map((d) => d.name);
  assert.deepEqual(names, ["sub"]);
  assert.equal(result.parent !== null, true);
  if (process.platform === "win32") {
    const roots = browseDirectories("");
    assert.ok((roots.roots ?? []).length > 0, "drive roots are listed");
  }
});

test("server: switching workspace creates or reuses a session", async () => {
  await withHome(async () => {
    const rootA = await tempDir();
    const rootB = await tempDir();
    const session = makeSession(rootA);
    await session.init();

    const server = await startServer({
      session,
      makeSession: async (root?: string) => makeSession(root ?? rootA),
      logger,
      port: 0,
      providerId: "mock",
      autoApprove: true,
    });

    try {
      const before = await (await fetch(server.url + "api/workspaces")).json();
      assert.equal(real(before.current), real(rootA));
      assert.deepEqual(before.recent, []);

      const switched = await (
        await fetch(server.url + "api/workspace", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: rootB }),
        })
      ).json();
      assert.equal(real(switched.workspace), real(rootB));
      assert.equal(switched.messages.length, 0, "new session starts empty");
      assert.equal(switched.sessions.length, 2);

      const recent = await (await fetch(server.url + "api/workspaces")).json();
      assert.equal(real(recent.recent[0].path), real(rootB));

      // 同一路径再次打开：复用会话，不重复创建
      const again = await (
        await fetch(server.url + "api/workspace", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: rootB }),
        })
      ).json();
      assert.equal(again.sessionId, switched.sessionId);
      assert.equal(again.sessions.length, 2);

      const bad = await fetch(server.url + "api/workspace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: path.join(rootB, "missing-dir") }),
      });
      assert.equal(bad.status, 400);

      const browse = await (await fetch(server.url + "api/browse?path=" + encodeURIComponent(rootA))).json();
      assert.equal(real(browse.path), real(rootA));
      assert.ok(Array.isArray(browse.dirs));
    } finally {
      await server.close();
    }
  });
});
test("workspace: favorites are pinned, listed and removable", async () => {
  await withHome(async () => {
    const a = await tempDir();
    const b = await tempDir();
    assert.deepEqual(listFavoriteEntries(), []);

    assert.equal(setFavorite(a, true), true);
    assert.equal(setFavorite(b, true), true);
    const favorites = listFavoriteEntries();
    assert.equal(favorites.length, 2);
    assert.equal(real(favorites[0].path), real(b), "新收藏排在最前");
    assert.equal(favorites[0].favorite, true);

    // 收藏过的路径出现在最近列表里时，带 favorite 标记
    rememberWorkspace(a);
    const recent = listRecentEntries();
    const entryA = recent.find((e) => real(e.path) === real(a));
    assert.ok(entryA);
    assert.equal(entryA!.favorite, true);

    assert.equal(setFavorite(a, false), false);
    assert.equal(listFavoriteEntries().length, 1);
});
});

test("workspace: entry metadata (name, kind) and legacy migration", async () => {
  await withHome(async () => {
    const nodeProj = await tempDir("mh-node-");
    const gitProj = await tempDir("mh-git-");
    await writeFile(path.join(nodeProj, "package.json"), "{}", "utf8");
    await mkdir(path.join(gitProj, ".git"));

    assert.equal(detectWorkspaceKind(nodeProj), "node");
    assert.equal(detectWorkspaceKind(gitProj), "git");
    assert.equal(detectWorkspaceKind(os.tmpdir()), "dir");

    rememberWorkspace(nodeProj);
    const entry = listRecentEntries()[0];
    assert.equal(entry.name, path.basename(nodeProj));
    assert.equal(entry.kind, "node");
    assert.equal(entry.exists, true);

    // 旧版本存的是 string[]：读取时迁移并保留
    const { writeFileSync, readFileSync } = await import("node:fs");
    const { userSettingsPath } = await import("../src/core/configStore.ts");
    const file = userSettingsPath();
    const data = JSON.parse(readFileSync(file, "utf8"));
    data.recentWorkspaces = [gitProj];
    writeFileSync(file, JSON.stringify(data, null, 2), "utf8");

    const migrated = listRecentEntries();
    assert.equal(migrated.length, 1);
    assert.equal(real(migrated[0].path), real(gitProj));
    assert.equal(migrated[0].kind, "git");
    assert.equal(migrated[0].at, 0, "旧数据没有时间戳");
});
});

test("server: favorites API toggles and returns both lists", async () => {
  await withHome(async () => {
    const rootA = await tempDir();
    const rootB = await tempDir();
    const session = makeSession(rootA);
    await session.init();

    const server = await startServer({
      session,
      makeSession: async (root?: string) => makeSession(root ?? rootA),
      logger,
      port: 0,
      providerId: "mock",
      autoApprove: true,
    });

    try {
      const added = await (
        await fetch(server.url + "api/workspaces/favorite", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: rootB, favorite: true }),
        })
      ).json();
      assert.equal(added.favorite, true);
      assert.equal(added.favorites.length, 1);
      assert.equal(real(added.favorites[0].path), real(rootB));

      const listed = await (await fetch(server.url + "api/workspaces")).json();
      assert.equal(listed.favorites.length, 1);
      assert.ok(Array.isArray(listed.recent));

      const removed = await (
        await fetch(server.url + "api/workspaces/favorite", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: rootB, favorite: false }),
        })
      ).json();
      assert.equal(removed.favorite, false);
      assert.equal(removed.favorites.length, 0);

      const bad = await fetch(server.url + "api/workspaces/favorite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: path.join(rootB, "missing"), favorite: true }),
      });
      assert.equal(bad.status, 400);
    } finally {
      await server.close();
    }
  });
});