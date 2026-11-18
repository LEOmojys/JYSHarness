import assert from "node:assert/strict";
import test from "node:test";
import * as swe from "../src/bench/swebench.ts";

const regression = "tests/fix.py::test_case[first sample]";
const preserved = "tests/stable.py::test_stable";

test("SWE requires passing evidence for each requested test", () => {
  const output = "PASSED " + regression + "\nSKIPPED " + preserved;
  const result = swe.scoreTests([regression], [preserved], swe.parseTestRun(output, 0));
  assert.equal(result.f2pPassed, 1);
  assert.equal(result.p2pFailed, 1);
  assert.equal(result.resolved, false);
});

test("SWE requires a successful pytest exit even when every test printed PASSED", () => {
  const output = "PASSED " + regression + "\n" + preserved + " PASSED [100%]";
  for (const status of [0, 1, null]) {
    const result = swe.scoreTests([regression], [preserved], swe.parseTestRun(output, status));
    assert.equal(result.f2pPassed, 1);
    assert.equal(result.p2pFailed, 0);
    assert.equal(result.resolved, status === 0);
  }
});

test("SWE requires a non-empty failing-to-passing set", () => {
  assert.equal(swe.scoreTests([], [], swe.parseTestRun("", 0)).resolved, false);
});

test("SWE selects supported nonempty pytest instances before applying the limit", () => {
  const supported: swe.SweInstance = {
    repo: "pallets/flask", version: "2.3", instance_id: "flask__sample", problem_statement: "",
    test_patch: "", base_commit: "", FAIL_TO_PASS: [regression], PASS_TO_PASS: [preserved],
  };
  const unsupported = { ...supported, version: "unknown", PASS_TO_PASS: [] };
  const empty = { ...supported, FAIL_TO_PASS: [] };
  assert.deepEqual(swe.selectInstances([empty, unsupported, supported], { limit: 1 }), [supported]);
});
