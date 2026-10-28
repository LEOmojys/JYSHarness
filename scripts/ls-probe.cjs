const fs = require("node:fs");
process.stdout.write(fs.readdirSync("node_modules").join(","));
