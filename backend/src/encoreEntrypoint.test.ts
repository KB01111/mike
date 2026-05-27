import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("Encore app entrypoint stays importable without CommonJS direct-run guards", () => {
  const indexPath = path.join(__dirname, "index.ts");
  const source = fs.readFileSync(indexPath, "utf8");

  assert.equal(source.includes("require.main"), false);
  assert.equal(source.includes("module)"), false);
});
