import assert from "node:assert/strict";
import test from "node:test";
import {
  createPasswordHash,
  normalizeEmail,
  signSessionToken,
  verifyPassword,
  verifySessionToken,
} from "./localAuth";

test("normalizes emails for login and legacy data claiming", () => {
  assert.equal(normalizeEmail("  Owner@Example.COM "), "owner@example.com");
});

test("hashes passwords with a random salt and verifies only the original password", async () => {
  const first = await createPasswordHash("correct horse battery staple");
  const second = await createPasswordHash("correct horse battery staple");

  assert.notEqual(first.passwordHash, second.passwordHash);
  assert.notEqual(first.passwordSalt, second.passwordSalt);
  assert.equal(
    await verifyPassword("correct horse battery staple", first),
    true,
  );
  assert.equal(await verifyPassword("wrong password", first), false);
});

test("signs and verifies bearer session tokens with user id and email", () => {
  const token = signSessionToken({
    userId: "8f13e3df-6b66-4b5b-98d4-23b3a6ad0618",
    email: "owner@example.com",
    expiresInSeconds: 60,
    secret: "test-secret",
  });

  assert.deepEqual(verifySessionToken(token, "test-secret"), {
    userId: "8f13e3df-6b66-4b5b-98d4-23b3a6ad0618",
    email: "owner@example.com",
  });
  assert.equal(verifySessionToken(`${token}x`, "test-secret"), null);
  assert.equal(verifySessionToken(token, "different-secret"), null);
});

test("rejects expired bearer session tokens", () => {
  const token = signSessionToken({
    userId: "8f13e3df-6b66-4b5b-98d4-23b3a6ad0618",
    email: "owner@example.com",
    expiresInSeconds: -1,
    secret: "test-secret",
  });

  assert.equal(verifySessionToken(token, "test-secret"), null);
});
