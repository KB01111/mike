import assert from "node:assert/strict";
import test from "node:test";
import { r2PhysicalKey, stripR2Prefix } from "./storagePaths";

test("maps logical storage keys into a configured R2 prefix", () => {
  assert.equal(
    r2PhysicalKey("documents/user/doc/source.pdf", "mike-v2"),
    "mike-v2/documents/user/doc/source.pdf",
  );
});

test("does not double-prefix keys already copied into the R2 migration prefix", () => {
  assert.equal(
    r2PhysicalKey("mike-v2/documents/user/doc/source.pdf", "mike-v2"),
    "mike-v2/documents/user/doc/source.pdf",
  );
});

test("leaves logical storage keys untouched when no R2 prefix is configured", () => {
  assert.equal(
    r2PhysicalKey("documents/user/doc/source.pdf", ""),
    "documents/user/doc/source.pdf",
  );
});

test("can strip the configured R2 prefix for migration reports", () => {
  assert.equal(
    stripR2Prefix("mike-v2/documents/user/doc/source.pdf", "mike-v2"),
    "documents/user/doc/source.pdf",
  );
});
