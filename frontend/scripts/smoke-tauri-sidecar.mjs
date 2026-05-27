import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.PORT || "3070";
const url = `http://127.0.0.1:${port}`;

function output(command, args) {
    return execFileSync(command, args, {
        cwd: projectRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}

function hostTuple() {
    try {
        return output("rustc", ["--print", "host-tuple"]);
    } catch {
        const rustInfo = output("rustc", ["-Vv"]);
        const match = rustInfo.match(/^host:\s+(\S+)$/m);
        if (!match) throw new Error("Could not determine Rust host tuple");
        return match[1];
    }
}

const extension = process.platform === "win32" ? ".exe" : "";
const sidecarPath = path.join(
    projectRoot,
    "src-tauri",
    "binaries",
    `mike-node-${hostTuple()}${extension}`,
);
const standaloneDir =
    process.env.MIKE_NEXT_STANDALONE_DIR ||
    path.join(projectRoot, ".next", "standalone");
const serverJsPath = path.join(standaloneDir, "server.js");

if (!fs.existsSync(sidecarPath)) {
    console.error(`ERROR: Sidecar binary not found: ${sidecarPath}`);
    process.exit(1);
}

if (!fs.existsSync(serverJsPath)) {
    console.error(`ERROR: Next standalone server not found: ${standaloneDir}`);
    process.exit(1);
}

const child = spawn(sidecarPath, [serverJsPath], {
    cwd: standaloneDir,
    env: {
        ...process.env,
        MIKE_NEXT_STANDALONE_DIR: standaloneDir,
        PORT: port,
        HOSTNAME: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
});
child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
});

try {
    let status = null;
    for (let i = 0; i < 60; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (child.exitCode !== null) break;
        try {
            const response = await fetch(url);
            status = response.status;
            if (status >= 200 && status < 500) {
                console.log(`Sidecar responded on ${url} with status ${status}`);
                process.exitCode = 0;
                break;
            }
        } catch {
            // Keep polling until the sidecar is ready or exits.
        }
    }

    if (process.exitCode !== 0) {
        console.error(
            `ERROR: Sidecar did not respond on ${url}. Last status: ${status ?? "none"}`,
        );
        if (stdout) console.error(`stdout:\n${stdout}`);
        if (stderr) console.error(`stderr:\n${stderr}`);
        process.exitCode = 1;
    }
} finally {
    if (child.exitCode === null) child.kill();
}
