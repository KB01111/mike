/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("node:fs");
const path = require("node:path");

const port = process.env.PORT || "3070";
const hostname = process.env.HOSTNAME || "127.0.0.1";

process.env.PORT = port;
process.env.HOSTNAME = hostname;

function candidates() {
    return [
        process.env.MIKE_NEXT_STANDALONE_DIR,
        path.join(process.cwd(), ".next", "standalone"),
        path.join(path.dirname(process.execPath), "resources", ".next", "standalone"),
        path.join(path.dirname(process.execPath), ".next", "standalone"),
        path.join(__dirname, "..", ".next", "standalone"),
    ].filter(Boolean);
}

const standaloneDir = candidates().find((dir) =>
    fs.existsSync(path.join(dir, "server.js")),
);

if (!standaloneDir) {
    console.error(
        `Could not find Next standalone server.js. Tried: ${candidates().join(", ")}`,
    );
    process.exit(1);
}

process.chdir(standaloneDir);
require(path.join(standaloneDir, "server.js"));
