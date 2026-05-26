import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  createPasswordHash,
  getSessionSecret,
  normalizeEmail,
  signSessionToken,
  verifyPassword,
} from "../lib/localAuth";
import { createServerDb } from "../lib/dbClient";
import { requireAuth } from "../middleware/auth";

export const authRouter = Router();

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function minutes(value: number): number {
  return value * 60 * 1000;
}

const authLimiter = rateLimit({
  windowMs: minutes(envInt("RATE_LIMIT_AUTH_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_AUTH_MAX", 10),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "OPTIONS",
  message: {
    detail: "Too many authentication requests. Please try again later.",
  },
});

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  password_salt: string;
};

function publicUser(row: { id: string; email: string }) {
  return { id: row.id, email: row.email };
}

function sessionResponse(row: { id: string; email: string }) {
  return {
    access_token: signSessionToken({
      userId: row.id,
      email: row.email,
      expiresInSeconds: SESSION_TTL_SECONDS,
      secret: getSessionSecret(),
    }),
    user: publicUser(row),
  };
}

function parseCredentials(body: unknown):
  | { ok: true; email: string; password: string }
  | { ok: false; detail: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, detail: "Expected a JSON object" };
  }
  const row = body as Record<string, unknown>;
  if (typeof row.email !== "string" || !row.email.trim()) {
    return { ok: false, detail: "Email is required" };
  }
  if (typeof row.password !== "string" || row.password.length < 6) {
    return { ok: false, detail: "Password must be at least 6 characters" };
  }
  return { ok: true, email: normalizeEmail(row.email), password: row.password };
}

async function ensureProfile(userId: string) {
  const db = createServerDb();
  await db.from("user_profiles").upsert(
    {
      user_id: userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id", ignoreDuplicates: true },
  );
}

async function claimLegacyDataByEmail(email: string, userId: string) {
  const db = createServerDb();
  const { data } = await db
    .from("legacy_user_map")
    .select("legacy_user_id")
    .eq("email", email);
  const legacyIds = ((data ?? []) as { legacy_user_id: string }[]).map(
    (row) => row.legacy_user_id,
  );
  if (legacyIds.length === 0) return;

  const userOwnedTables = [
    "projects",
    "project_subfolders",
    "documents",
    "workflows",
    "hidden_workflows",
    "chats",
    "tabular_reviews",
    "tabular_review_chats",
  ];

  // Perform updates sequentially with error handling
  const errors: string[] = [];
  for (const table of userOwnedTables) {
    for (const legacyId of legacyIds) {
      const { error } = await db.from(table).update({ user_id: userId }).eq("user_id", legacyId);
      if (error) {
        errors.push(`Failed to update ${table} for legacy user ${legacyId}: ${error.message}`);
      }
    }
  }

  const existingProfile = await db
    .from("user_profiles")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();
  if (!existingProfile.data) {
    for (const legacyId of legacyIds) {
      const { error } = await db
        .from("user_profiles")
        .update({ user_id: userId, updated_at: new Date().toISOString() })
        .eq("user_id", legacyId);
      if (error) {
        errors.push(`Failed to update user_profiles for legacy user ${legacyId}: ${error.message}`);
      }
    }
  }

  for (const legacyId of legacyIds) {
    const { error } = await db
      .from("workflow_shares")
      .update({ shared_by_user_id: userId })
      .eq("shared_by_user_id", legacyId);
    if (error) {
      errors.push(`Failed to update workflow_shares for legacy user ${legacyId}: ${error.message}`);
    }
  }

  const { error: mapError } = await db
    .from("legacy_user_map")
    .update({ claimed_user_id: userId, claimed_at: new Date().toISOString() })
    .eq("email", email);
  if (mapError) {
    errors.push(`Failed to update legacy_user_map: ${mapError.message}`);
  }

  if (errors.length > 0) {
    console.error("[auth] Legacy data migration had errors:", errors);
  }
}

authRouter.post("/signup", authLimiter, async (req, res) => {
  const parsed = parseCredentials(req.body);
  if (!parsed.ok) return void res.status(400).json({ detail: parsed.detail });

  const db = createServerDb();
  const existing = await db
    .from("users")
    .select("id")
    .eq("email", parsed.email)
    .maybeSingle();
  if (existing.error) {
    return void res.status(500).json({ detail: existing.error.message });
  }
  if (existing.data) {
    return void res.status(409).json({ detail: "Email is already registered" });
  }

  const { passwordHash, passwordSalt } = await createPasswordHash(parsed.password);
  const created = await db
    .from("users")
    .insert({
      email: parsed.email,
      password_hash: passwordHash,
      password_salt: passwordSalt,
    })
    .select("id, email")
    .single();
  if (created.error || !created.data) {
    return void res
      .status(500)
      .json({ detail: created.error?.message ?? "Failed to create account" });
  }

  const user = created.data as { id: string; email: string };
  await claimLegacyDataByEmail(parsed.email, user.id);
  await ensureProfile(user.id);
  res.status(201).json(sessionResponse(user));
});

authRouter.post("/login", authLimiter, async (req, res) => {
  const parsed = parseCredentials(req.body);
  if (!parsed.ok) return void res.status(400).json({ detail: parsed.detail });

  const db = createServerDb();
  const { data, error } = await db
    .from("users")
    .select("id, email, password_hash, password_salt")
    .eq("email", parsed.email)
    .maybeSingle();
  if (error) return void res.status(500).json({ detail: error.message });
  const user = data as UserRow | null;
  if (
    !user ||
    !(await verifyPassword(parsed.password, {
      passwordHash: user.password_hash,
      passwordSalt: user.password_salt,
    }))
  ) {
    return void res.status(401).json({ detail: "Invalid email or password" });
  }

  await claimLegacyDataByEmail(parsed.email, user.id);
  await ensureProfile(user.id);
  res.json(sessionResponse(user));
});

authRouter.get("/session", requireAuth, async (_req, res) => {
  res.json({
    user: {
      id: res.locals.userId as string,
      email: res.locals.userEmail as string,
    },
    access_token: res.locals.token as string,
  });
});

authRouter.post("/refresh", requireAuth, async (_req, res) => {
  res.json(
    sessionResponse({
      id: res.locals.userId as string,
      email: res.locals.userEmail as string,
    }),
  );
});

authRouter.post("/logout", (_req, res) => {
  res.status(204).send();
});
