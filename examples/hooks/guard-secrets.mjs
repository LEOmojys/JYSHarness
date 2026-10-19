#!/usr/bin/env node
/**
 * Example PreToolUse hook: block writes to secrets and .env files.
 *
 * Protocol: JSON payload on stdin, JSON result on stdout.
 * Exit code 2 also blocks (stderr becomes the reason).
 */
let raw = "";
process.stdin.on("data", (d) => (raw += d.toString("utf8")));
process.stdin.on("end", () => {
  let payload = {};
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    process.exit(0);
  }
  const input = payload.toolInput ?? {};
  const target = String(input.file_path ?? input.path ?? "");
  const cmd = String(input.command ?? "");
  const banned = /\.env(\.|$)|secrets?[\\/]/i;

  if (target && banned.test(target)) {
    process.stdout.write(
      JSON.stringify({ decision: "deny", reason: "refusing to touch secrets: " + target }),
    );
    return;
  }
  if (cmd && /(^|\s)printenv\b|(^|\s)env\s*$/.test(cmd)) {
    process.stdout.write(JSON.stringify({ decision: "deny", reason: "refusing to dump the environment" }));
    return;
  }
  // Plain pass-through: no output means allow.
});
