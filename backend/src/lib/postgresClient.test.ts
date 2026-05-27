import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresClient, type SqlExecutor } from "./postgresClient";

class FakeExecutor implements SqlExecutor {
  calls: { kind: string; sql: string; params: unknown[] }[] = [];
  rows: Record<string, unknown>[] = [];

  async rawQueryAll<T extends Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T[]> {
    this.calls.push({ kind: "all", sql, params });
    return this.rows as T[];
  }

  async rawQueryRow<T extends Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T | null> {
    this.calls.push({ kind: "row", sql, params });
    return (this.rows[0] as T) ?? null;
  }

  async rawExec(sql: string, ...params: unknown[]): Promise<void> {
    this.calls.push({ kind: "exec", sql, params });
  }
}

test("selects rows with filters, ordering, and limits", async () => {
  const exec = new FakeExecutor();
  exec.rows = [{ id: "project-1" }];
  const db = createPostgresClient(exec);

  const result = await db
    .from("projects")
    .select("*")
    .eq("user_id", "user-1")
    .order("created_at", { ascending: false })
    .limit(10);

  assert.deepEqual(result, { data: [{ id: "project-1" }], error: null });
  assert.equal(
    exec.calls[0].sql,
    'SELECT * FROM "projects" WHERE "user_id" = $1 ORDER BY "created_at" DESC LIMIT 10',
  );
  assert.deepEqual(exec.calls[0].params, ["user-1"]);
});

test("supports JSON containment filters for shared email lists", async () => {
  const exec = new FakeExecutor();
  const db = createPostgresClient(exec);

  await db
    .from("projects")
    .select("id")
    .filter("shared_with", "cs", JSON.stringify(["member@example.com"]));

  assert.equal(
    exec.calls[0].sql,
    'SELECT "id" FROM "projects" WHERE "shared_with" @> $1::jsonb',
  );
  assert.deepEqual(exec.calls[0].params, ['["member@example.com"]']);
});

test("inserts a row and returns selected columns", async () => {
  const exec = new FakeExecutor();
  exec.rows = [{ id: "doc-1" }];
  const db = createPostgresClient(exec);

  const result = await db
    .from("documents")
    .insert({ user_id: "user-1", filename: "a.pdf" })
    .select("id")
    .single();

  assert.deepEqual(result, { data: { id: "doc-1" }, error: null });
  assert.equal(
    exec.calls[0].sql,
    'INSERT INTO "documents" ("user_id", "filename") VALUES ($1, $2) RETURNING "id"',
  );
  assert.deepEqual(exec.calls[0].params, ["user-1", "a.pdf"]);
});

test("serializes known JSONB insert values", async () => {
  const exec = new FakeExecutor();
  exec.rows = [{ id: "project-1" }];
  const db = createPostgresClient(exec);

  const result = await db
    .from("projects")
    .insert({ user_id: "user-1", shared_with: ["member@example.com"] })
    .select("id")
    .single();

  assert.deepEqual(result, { data: { id: "project-1" }, error: null });
  assert.equal(
    exec.calls[0].sql,
    'INSERT INTO "projects" ("user_id", "shared_with") VALUES ($1, $2::jsonb) RETURNING "id"',
  );
  assert.deepEqual(exec.calls[0].params, [
    "user-1",
    '["member@example.com"]',
  ]);
});

test("serializes known JSONB update values", async () => {
  const exec = new FakeExecutor();
  exec.rows = [{ id: "review-1" }];
  const db = createPostgresClient(exec);

  await db
    .from("tabular_reviews")
    .update({ columns_config: [{ index: 0, name: "Clause" }] })
    .eq("id", "review-1")
    .select("id")
    .single();

  assert.equal(
    exec.calls[0].sql,
    'UPDATE "tabular_reviews" SET "columns_config" = $1::jsonb WHERE "id" = $2 RETURNING "id"',
  );
  assert.deepEqual(exec.calls[0].params, [
    '[{"index":0,"name":"Clause"}]',
    "review-1",
  ]);
});

test("upserts by conflict columns and can ignore duplicates", async () => {
  const exec = new FakeExecutor();
  const db = createPostgresClient(exec);

  await db
    .from("hidden_workflows")
    .upsert(
      { user_id: "user-1", workflow_id: "wf-1" },
      { onConflict: "user_id,workflow_id", ignoreDuplicates: true },
    );

  assert.equal(
    exec.calls[0].sql,
    'INSERT INTO "hidden_workflows" ("user_id", "workflow_id") VALUES ($1, $2) ON CONFLICT ("user_id", "workflow_id") DO NOTHING',
  );
  assert.deepEqual(exec.calls[0].params, ["user-1", "wf-1"]);
});

test("returns counts for head exact selects", async () => {
  const exec = new FakeExecutor();
  exec.rows = [{ count: 3 }];
  const db = createPostgresClient(exec);

  const result = await db
    .from("documents")
    .select("id", { count: "exact", head: true })
    .eq("project_id", "project-1");

  assert.deepEqual(result, { data: null, error: null, count: 3 });
  assert.equal(
    exec.calls[0].sql,
    'SELECT count(*)::int AS count FROM "documents" WHERE "project_id" = $1',
  );
});
