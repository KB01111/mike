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

function pkgTargetFor(targetTriple) {
    if (targetTriple === "x86_64-pc-windows-msvc") return "node20-win-x64";
    if (targetTriple === "aarch64-pc-windows-msvc") return "node20-win-arm64";
    if (targetTriple === "x86_64-apple-darwin") return "node20-macos-x64";
    if (targetTriple === "aarch64-apple-darwin") return "node20-macos-arm64";
    if (targetTriple === "x86_64-unknown-linux-gnu") return "node20-linux-x64";
    if (targetTriple === "aarch64-unknown-linux-gnu") return "node20-linux-arm64";
    throw new Error(`Unsupported sidecar target triple: ${targetTriple}`);
}

function copyIfExists(source, destination) {
    if (!fs.existsSync(source)) return;
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(source, destination, { recursive: true, force: true });
}

run(bin("npm"), ["run", "build"], {
    env: {
        ...process.env,
        MIKE_DESKTOP_BUILD: "1",
    },
});

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
const temporaryOutput = path.join(binariesDir, `mike-next-sidecar${extension}`);
const finalOutput = path.join(
    binariesDir,
    `mike-next-sidecar-${targetTriple}${extension}`,
);
const pkgBinary = path.join(projectRoot, "node_modules", ".bin", bin("pkg"));

fs.rmSync(temporaryOutput, { force: true });
fs.rmSync(finalOutput, { force: true });

run(pkgBinary, [
    "scripts/mike-next-sidecar.cjs",
    "--targets",
    pkgTargetFor(targetTriple),
    "--output",
    temporaryOutput,
]);

fs.renameSync(temporaryOutput, finalOutput);
console.log(`Prepared Tauri sidecar: ${path.relative(projectRoot, finalOutput)}`);
