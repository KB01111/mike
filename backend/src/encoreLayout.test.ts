import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const serviceDir = __dirname;
const backendDir = path.resolve(serviceDir, "..");

test("Encore migrations live under the service directory with .up.sql suffixes", () => {
  const migrationsDir = path.join(serviceDir, "migrations");
  assert.equal(fs.existsSync(migrationsDir), true);

  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  assert.deepEqual(migrationFiles, ["001_initial.up.sql"]);
});

test("legacy root migration directory is not the active Encore migration source", () => {
  const legacyMigration = path.join(backendDir, "migrations", "001_initial.sql");
  assert.equal(fs.existsSync(legacyMigration), false);
});
