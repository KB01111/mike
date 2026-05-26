import { mikeDb } from "../db";
import {
  getSessionSecret,
  verifySessionToken,
} from "./localAuth";
import { createPostgresClient } from "./postgresClient";
import type { PostgresCompatClient } from "./postgresClient";

/**
 * Compatibility wrapper for the Postgres query client.
 *
 * During the Encore migration, existing routes keep their `db.from(...)`
 * shape while this layer translates the subset Mike uses into Postgres SQL.
 */
export function createServerDb(): PostgresCompatClient {
  return createPostgresClient(mikeDb);
}

export async function getUserIdFromRequest(req: Request): Promise<string> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    throw new Response("Missing or invalid Authorization header", {
      status: 401,
    });
  }

  const verified = verifySessionToken(auth.slice(7).trim(), getSessionSecret());
  if (!verified) {
    throw new Response("Invalid or expired token", { status: 401 });
  }
  return verified.userId;
}
