import fs from "node:fs/promises";
import path from "node:path";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { Client } from "pg";
import { r2PhysicalKey } from "../lib/storagePaths";

type JsonRow = Record<string, unknown>;

type SupabaseUser = {
  id: string;
  email?: string | null;
};

type TableReport = {
  exported: number;
  imported: number;
  skipped: number;
  failed: number;
};

type ObjectReport = {
  logicalKey: string;
  physicalKey: string;
  status: "copied" | "skipped" | "failed";
  bytes?: number;
  reason?: string;
};

const PAGE_SIZE = 1000;
const TABLES = [
  "user_profiles",
  "projects",
  "project_subfolders",
  "documents",
  "document_versions",
  "document_edits",
  "workflows",
  "hidden_workflows",
  "workflow_shares",
  "chats",
  "chat_messages",
  "tabular_reviews",
  "tabular_cells",
  "tabular_review_chats",
  "tabular_review_chat_messages",
] as const;

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function requiredEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function supabaseHeaders(): Record<string, string> {
  const serviceKey = requiredEnv("MIGRATION_SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      ...supabaseHeaders(),
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`${url} failed with ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function fetchTable(table: string): Promise<JsonRow[]> {
  const baseUrl = requiredEnv("MIGRATION_SUPABASE_URL").replace(/\/+$/, "");
  const rows: JsonRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = new URL(`${baseUrl}/rest/v1/${table}`);
    url.searchParams.set("select", "*");
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("offset", String(offset));
    const page = await fetchJson<JsonRow[]>(url.toString());
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function fetchAuthUsers(): Promise<SupabaseUser[]> {
  const baseUrl = requiredEnv("MIGRATION_SUPABASE_URL").replace(/\/+$/, "");
  const users: SupabaseUser[] = [];
  for (let page = 1; ; page++) {
    const url = new URL(`${baseUrl}/auth/v1/admin/users`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(PAGE_SIZE));
    const body = await fetchJson<{ users?: SupabaseUser[] }>(url.toString());
    const batch = body.users ?? [];
    users.push(...batch.filter((user) => user.id));
    if (batch.length < PAGE_SIZE) break;
  }
  return users;
}

function quoteIdent(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

async function insertRows(
  client: Client,
  table: string,
  rows: JsonRow[],
): Promise<{ imported: number; failed: number }> {
  let imported = 0;
  let failed = 0;
  for (const row of rows) {
    const entries = Object.entries(row).filter(([, value]) => value !== undefined);
    if (entries.length === 0) {
      failed++;
      continue;
    }
    const columns = entries.map(([column]) => column);
    const values = entries.map(([, value]) => value);
    const placeholders = values.map((_, index) => `$${index + 1}`);
    try {
      const result = await client.query(
        `insert into ${quoteIdent(table)} (${columns
          .map(quoteIdent)
          .join(", ")}) values (${placeholders.join(", ")}) on conflict do nothing`,
        values,
      );
      imported += result.rowCount ?? 0;
    } catch (error) {
      failed++;
      console.warn(
        `[migration] failed to import ${table} row ${JSON.stringify(row.id ?? row)}`,
        error,
      );
    }
  }
  return { imported, failed };
}

async function upsertLegacyUsers(
  client: Client,
  users: SupabaseUser[],
): Promise<{ imported: number; unresolved: SupabaseUser[] }> {
  let imported = 0;
  const unresolved: SupabaseUser[] = [];
  for (const user of users) {
    if (!user.email) {
      unresolved.push(user);
      continue;
    }
    try {
      const result = await client.query(
        `insert into "legacy_user_map" ("legacy_user_id", "email")
         values ($1, lower($2))
         on conflict ("legacy_user_id") do update set "email" = excluded."email"`,
        [user.id, user.email],
      );
      imported += result.rowCount ?? 0;
    } catch (error) {
      console.error("[migration] Failed to upsert legacy user: upsert error", error);
      unresolved.push(user);
    }
  }
  return { imported, unresolved };
}

function storageKeysFromRows(rowsByTable: Map<string, JsonRow[]>): string[] {
  const keys = new Set<string>();
  for (const rows of rowsByTable.values()) {
    for (const row of rows) {
      for (const column of ["storage_path", "pdf_storage_path"]) {
        const value = row[column];
        if (typeof value === "string" && value.trim()) {
          keys.add(value);
        }
      }
    }
  }
  return [...keys].sort();
}

function r2Env(prefix: "MIGRATION_R2_SOURCE" | "R2", key: string): string {
  if (prefix === "MIGRATION_R2_SOURCE") {
    return (
      optionalEnv(`MIGRATION_R2_SOURCE_${key}`) ??
      requiredEnv(`R2_${key}`)
    );
  }
  return requiredEnv(`R2_${key}`);
}

function s3Client(prefix: "MIGRATION_R2_SOURCE" | "R2"): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: r2Env(prefix, "ENDPOINT_URL"),
    forcePathStyle: true,
    credentials: {
      accessKeyId: r2Env(prefix, "ACCESS_KEY_ID"),
      secretAccessKey: r2Env(prefix, "SECRET_ACCESS_KEY"),
    },
  });
}

function sourceBucket(): string {
  return (
    optionalEnv("MIGRATION_R2_SOURCE_BUCKET_NAME") ??
    optionalEnv("R2_BUCKET_NAME") ??
    "mike"
  );
}

function destinationBucket(): string {
  return optionalEnv("R2_BUCKET_NAME") ?? "mike";
}

async function bodyToBytes(
  body: GetObjectCommandOutput["Body"],
): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  if ("transformToByteArray" in body) {
    return body.transformToByteArray();
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array | Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function destinationSize(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<number | null> {
  try {
    const head = await client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );
    return head.ContentLength ?? null;
  } catch {
    return null;
  }
}

async function copyObject(
  source: S3Client,
  destination: S3Client,
  logicalKey: string,
): Promise<ObjectReport> {
  const physicalKey = r2PhysicalKey(logicalKey);
  try {
    const sourceObject = await source.send(
      new GetObjectCommand({
        Bucket: sourceBucket(),
        Key: logicalKey,
      }),
    );
    const bytes = await bodyToBytes(sourceObject.Body);
    const existingSize = await destinationSize(
      destination,
      destinationBucket(),
      physicalKey,
    );
    if (existingSize === bytes.byteLength) {
      return {
        logicalKey,
        physicalKey,
        status: "skipped",
        bytes: bytes.byteLength,
        reason: "destination object already exists with matching size",
      };
    }
    await destination.send(
      new PutObjectCommand({
        Bucket: destinationBucket(),
        Key: physicalKey,
        Body: bytes,
        ContentType: sourceObject.ContentType,
      }),
    );
    return {
      logicalKey,
      physicalKey,
      status: "copied",
      bytes: bytes.byteLength,
    };
  } catch (error) {
    return {
      logicalKey,
      physicalKey,
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function copyObjects(logicalKeys: string[]): Promise<ObjectReport[]> {
  if (process.argv.includes("--skip-objects")) {
    return logicalKeys.map((logicalKey) => ({
      logicalKey,
      physicalKey: r2PhysicalKey(logicalKey),
      status: "skipped",
      reason: "--skip-objects",
    }));
  }
  const source = s3Client("MIGRATION_R2_SOURCE");
  const destination = s3Client("R2");
  const reports: ObjectReport[] = [];
  for (const key of logicalKeys) {
    reports.push(await copyObject(source, destination, key));
  }
  return reports;
}

async function main() {
  const client = new Client({
    connectionString: requiredEnv("DATABASE_URL"),
  });
  const rowsByTable = new Map<string, JsonRow[]>();
  const tableReports: Record<string, TableReport> = {};
  await client.connect();

  try {
    const users = await fetchAuthUsers();
    const legacy = await upsertLegacyUsers(client, users);
    tableReports.legacy_user_map = {
      exported: users.length,
      imported: legacy.imported,
      skipped: 0,
      failed: legacy.unresolved.length,
    };
    if (legacy.unresolved.length > 0) {
      console.warn(`[migration] ${legacy.unresolved.length} legacy users could not be imported (details in report file)`);
    }

    for (const table of TABLES) {
      const rows = await fetchTable(table);
      rowsByTable.set(table, rows);
      const result = await insertRows(client, table, rows);
      tableReports[table] = {
        exported: rows.length,
        imported: result.imported,
        skipped: rows.length - result.imported - result.failed,
        failed: result.failed,
      };
    }

    tableReports.user_api_keys = {
      exported: 0,
      imported: 0,
      skipped: 0,
      failed: 0,
    };

    const objectReports = await copyObjects(storageKeysFromRows(rowsByTable));
    const report = {
      generatedAt: new Date().toISOString(),
      tables: tableReports,
      objects: {
        total: objectReports.length,
        copied: objectReports.filter((object) => object.status === "copied").length,
        skipped: objectReports.filter((object) => object.status === "skipped").length,
        failed: objectReports.filter((object) => object.status === "failed").length,
        details: objectReports,
      },
      unresolvedLegacyUsers: legacy.unresolved,
      notes: [
        "user_api_keys are intentionally not migrated; users must re-enter model API keys.",
      ],
    };
    const reportPath = path.resolve(
      optionalEnv("MIGRATION_REPORT_PATH") ?? "migration-report.json",
    );
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[migration] wrote report to ${reportPath}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
