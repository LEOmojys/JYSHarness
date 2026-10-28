const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const f = path.join(os.tmpdir(), "probe-tmp.txt");
fs.writeFileSync(f, "ok");
process.stdout.write("TMPDIR=" + os.tmpdir() + " CONTENT=" + fs.readFileSync(f, "utf8"));
