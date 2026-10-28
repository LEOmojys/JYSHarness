const path = require("node:path");
const target = path.join(process.cwd(), "node_modules", "is-number");
const isNumber = require(target);
process.stdout.write(isNumber(42) ? "IS-NUMBER-OK" : "NO");
