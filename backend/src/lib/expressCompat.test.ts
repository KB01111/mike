import assert from "node:assert/strict";
import test from "node:test";
import { mountedRootPaths } from "./expressCompat";

test("mountedRootPaths includes Express and Encore raw root forms", () => {
  assert.deepEqual(mountedRootPaths("/projects"), [
    "/",
    "/projects",
    "/projects/",
  ]);
});
