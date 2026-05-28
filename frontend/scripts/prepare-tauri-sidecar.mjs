import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binariesDir = path.join(projectRoot, "src-tauri", "binaries");

function bin(name) {
    return process.platform === "win32" ? `${name}.cmd` : name;
}

function run(command, args, options = {}) {
    execFileSync(command, args, {
        cwd: projectRoot,
        stdio: "inherit",
        ...options,
    });
}

function output(command, args) {
    return execFileSync(command, args, {
        cwd: projectRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}

function npmRun(args, options = {}) {
    const npmCli = process.env.npm_execpath;
    if (npmCli && fs.existsSync(npmCli)) {
        run(process.execPath, [npmCli, ...args], options);
        return;
    }
    run(bin("npm"), args, options);
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

function copyIfExists(source, destination) {
    if (!fs.existsSync(source)) return;
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(source, destination, { recursive: true, force: true });
}

function loadEnvFile(filePath) {
    if (!fs.existsSync(filePath)) return;
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const equals = trimmed.indexOf("=");
        if (equals <= 0) continue;
        const key = trimmed.slice(0, equals).trim();
        let value = trimmed.slice(equals + 1).trim();
        if (
            (value.startsWith("\"") && value.endsWith("\"")) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}

loadEnvFile(path.join(projectRoot, ".env.local"));

const desktopApiBase =
    process.env.NEXT_PUBLIC_API_BASE_URL || process.env.MIKE_DESKTOP_API_BASE_URL;

if (!desktopApiBase) {
    console.error(
        "ERROR: Set NEXT_PUBLIC_API_BASE_URL or MIKE_DESKTOP_API_BASE_URL before building Mike desktop.",
    );
    console.error(
        "Example: $env:MIKE_DESKTOP_API_BASE_URL='http://localhost:3001'; npm run desktop:build",
    );
    process.exit(1);
}

npmRun(["run", "build"], {
    env: {
        ...process.env,
        MIKE_DESKTOP_BUILD: "1",
        NEXT_PUBLIC_MIKE_DESKTOP_BUILD: "1",
        NEXT_PUBLIC_API_BASE_URL: desktopApiBase,
    },
});

const serverJsPath = path.join(projectRoot, ".next", "standalone", "server.js");
if (!fs.existsSync(serverJsPath)) {
    console.error(`ERROR: Expected build output not found: ${serverJsPath}`);
    console.error("The Next.js standalone build did not produce server.js");
    process.exit(1);
}

copyIfExists(
    path.join(projectRoot, ".next", "static"),
    path.join(projectRoot, ".next", "standalone", ".next", "static"),
);
copyIfExists(
    path.join(projectRoot, "public"),
    path.join(projectRoot, ".next", "standalone", "public"),
);

fs.mkdirSync(binariesDir, { recursive: true });

const targetTriple = hostTuple();
const extension = process.platform === "win32" ? ".exe" : "";
const finalOutput = path.join(binariesDir, `mike-node-${targetTriple}${extension}`);

fs.rmSync(finalOutput, { force: true });
fs.copyFileSync(process.execPath, finalOutput);
if (process.platform !== "win32") {
    fs.chmodSync(finalOutput, 0o755);
}

console.log(`Prepared Tauri Node sidecar: ${path.relative(projectRoot, finalOutput)}`);
