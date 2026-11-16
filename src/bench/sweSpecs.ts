/**
 * 每个 (仓库, 版本) 的官方环境规格。
 *
 * 为什么必须抄这份表：SWE-bench 的实例与**依赖版本**强绑定。实测踩过两次：
 *   - 装最新 pytest → 老仓库 conftest 用 `monkeypatch.notset`（新版已删）→ 全 ERROR；
 *   - 装最新 Werkzeug → Flask 2.3 里 `werkzeug.__version__` 不存在 → 全 ERROR。
 * 这两种情况下 **gold patch 都过不了** —— 说明环境本身是坏的，任何分数都没有意义。
 *
 * 数据来源：swebench/harness/constants/python.py（官方仓库），只抄了 pytest 型仓库。
 */
export interface RepoSpec {
  python: string;
  /** 额外的版本锁（官方 pip_packages） */
  pins: string[];
  /** 官方测试命令（-rA 形态，判分解析依赖它） */
  testCmd: string;
}

const TEST_PYTEST = "pytest --no-header -rA --tb=no -p no:cacheprovider";

const SPECS: Record<string, Record<string, RepoSpec>> = {
  "pallets/flask": {
    // 2.2 / 2.3 / 3.0 / 3.1 都是 python 3.11 + 同一组锁版本
    "2.2": { python: "3.11", pins: ["setuptools==70.0.0", "click==8.1.3", "itsdangerous==2.1.2", "Jinja2==3.1.2", "MarkupSafe==2.1.1", "Werkzeug==2.3.7"], testCmd: TEST_PYTEST },
    "2.3": { python: "3.11", pins: ["setuptools==70.0.0", "click==8.1.3", "itsdangerous==2.1.2", "Jinja2==3.1.2", "MarkupSafe==2.1.1", "Werkzeug==2.3.7"], testCmd: TEST_PYTEST },
    "3.0": { python: "3.11", pins: ["setuptools==70.0.0", "click==8.1.3", "itsdangerous==2.1.2", "Jinja2==3.1.2", "MarkupSafe==2.1.1", "Werkzeug==2.3.7"], testCmd: TEST_PYTEST },
    "3.1": { python: "3.11", pins: ["setuptools==70.0.0", "click==8.1.3", "itsdangerous==2.1.2", "Jinja2==3.1.2", "MarkupSafe==2.1.1", "Werkzeug==2.3.7"], testCmd: TEST_PYTEST },
  },
  "pylint-dev/pylint": {
    "2.10": { python: "3.9", pins: ["setuptools"], testCmd: TEST_PYTEST },
    "2.14": { python: "3.9", pins: ["setuptools"], testCmd: TEST_PYTEST },
    "2.15": { python: "3.9", pins: ["setuptools"], testCmd: TEST_PYTEST },
    "3.0": { python: "3.9", pins: ["astroid==3.0.0a6", "setuptools"], testCmd: TEST_PYTEST },
  },
  "pytest-dev/pytest": {
    "7.2": { python: "3.9", pins: [], testCmd: TEST_PYTEST },
    "7.1": { python: "3.9", pins: [], testCmd: TEST_PYTEST },
    "6.3": { python: "3.9", pins: [], testCmd: TEST_PYTEST },
  },
};

export function specFor(repo: string, version: string): RepoSpec | null {
  const byVersion = SPECS[repo];
  if (!byVersion) return null;
  return byVersion[version] ?? null;
}

/** 哪些 (仓库, 版本) 有官方 spec —— CLI 的 --list-specs 会打印它，方便挑能跑的实例。 */
export function supportedRepos(): { repo: string; versions: string[] }[] {
  return Object.entries(SPECS).map(([repo, byVersion]) => ({ repo, versions: Object.keys(byVersion) }));
}
