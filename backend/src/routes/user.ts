import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { DEFAULT_TABULAR_MODEL, resolveModel } from "../lib/llm";
import {
  type ApiKeyStatus,
  getUserApiKeyStatus,
  hasEnvApiKey,
  normalizeApiKeyProvider,
  saveUserApiKey,
} from "../lib/userApiKeys";
import { deleteFile, storageEnabled } from "../lib/storage";

export const userRouter = Router();

const MONTHLY_CREDIT_LIMIT = 999999;

type UserProfileRow = {
  display_name: string | null;
  organisation: string | null;
  message_credits_used: number;
  credits_reset_date: string;
  tier: string;
  tabular_model: string;
};

function serializeProfile(
  row: UserProfileRow,
  apiKeyStatus?: ApiKeyStatus,
) {
  const creditsUsed = row.message_credits_used ?? 0;
  return {
    displayName: row.display_name,
    organisation: row.organisation,
    messageCreditsUsed: creditsUsed,
    creditsResetDate: row.credits_reset_date,
    creditsRemaining: Math.max(MONTHLY_CREDIT_LIMIT - creditsUsed, 0),
    tier: row.tier || "Free",
    tabularModel: resolveModel(row.tabular_model, DEFAULT_TABULAR_MODEL),
    ...(apiKeyStatus ? { apiKeyStatus } : {}),
  };
}

function validateProfilePayload(body: unknown):
  | {
      ok: true;
      update: {
        display_name?: string | null;
        organisation?: string | null;
        tabular_model?: string;
        updated_at: string;
      };
    }
  | { ok: false; detail: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, detail: "Expected a JSON object" };
  }

  const raw = body as Record<string, unknown>;
  const allowedFields = new Set([
    "displayName",
    "organisation",
    "tabularModel",
  ]);
  const invalidField = Object.keys(raw).find((key) => !allowedFields.has(key));
  if (invalidField) {
    return { ok: false, detail: `Unsupported profile field: ${invalidField}` };
  }

  const update: {
    display_name?: string | null;
    organisation?: string | null;
    tabular_model?: string;
    updated_at: string;
  } = { updated_at: new Date().toISOString() };

  if ("displayName" in raw) {
    if (raw.displayName !== null && typeof raw.displayName !== "string") {
      return { ok: false, detail: "displayName must be a string or null" };
    }
    update.display_name = raw.displayName?.trim() || null;
  }

  if ("organisation" in raw) {
    if (raw.organisation !== null && typeof raw.organisation !== "string") {
      return { ok: false, detail: "organisation must be a string or null" };
    }
    update.organisation = raw.organisation?.trim() || null;
  }

  if ("tabularModel" in raw) {
    if (typeof raw.tabularModel !== "string") {
      return { ok: false, detail: "tabularModel must be a string" };
    }
    const resolved = resolveModel(raw.tabularModel, "");
    if (!resolved) {
      return { ok: false, detail: "Unsupported tabularModel" };
    }
    update.tabular_model = resolved;
  }

  return { ok: true, update };
}

async function ensureProfileRow(
  db: ReturnType<typeof createServerSupabase>,
  userId: string,
) {
  const { error } = await db
    .from("user_profiles")
    .upsert(
      { user_id: userId },
      { onConflict: "user_id", ignoreDuplicates: true },
    );
  return error;
}

async function loadProfile(
  db: ReturnType<typeof createServerSupabase>,
  userId: string,
  options: { repairMissing?: boolean } = {},
) {
  let { data, error } = await db
    .from("user_profiles")
    .select(
      "display_name, organisation, message_credits_used, credits_reset_date, tier, tabular_model",
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error) return { data: null, error };
  if (!data) {
    if (!options.repairMissing) {
      return { data: null, error: new Error("Profile not found") };
    }

    const ensureError = await ensureProfileRow(db, userId);
    if (ensureError) return { data: null, error: ensureError };

    const created = await db
      .from("user_profiles")
      .select(
        "display_name, organisation, message_credits_used, credits_reset_date, tier, tabular_model",
      )
      .eq("user_id", userId)
      .single();
    if (created.error) return { data: null, error: created.error };
    data = created.data;
  }

  let row = data as UserProfileRow;
  if (row.credits_reset_date && new Date() > new Date(row.credits_reset_date)) {
    const creditsResetDate = new Date();
    creditsResetDate.setDate(creditsResetDate.getDate() + 30);
    const { data: resetData, error: resetError } = await db
      .from("user_profiles")
      .update({
        message_credits_used: 0,
        credits_reset_date: creditsResetDate.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .select(
        "display_name, organisation, message_credits_used, credits_reset_date, tier, tabular_model",
      )
      .single();

    if (resetError) return { data: null, error: resetError };
    row = resetData as UserProfileRow;
  }

  return { data: serializeProfile(row), error: null };
}

// POST /user/profile
userRouter.post("/profile", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const error = await ensureProfileRow(db, userId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.json({ ok: true });
});

// GET /user/profile
userRouter.get("/profile", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { data, error } = await loadProfile(db, userId, {
    repairMissing: true,
  });
  if (error) return void res.status(500).json({ detail: error.message });
  const apiKeyStatus = await getUserApiKeyStatus(userId, db);
  res.json({ ...data, apiKeyStatus });
});

// PATCH /user/profile
userRouter.patch("/profile", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const parsed = validateProfilePayload(req.body);
  if (!parsed.ok) return void res.status(400).json({ detail: parsed.detail });

  const db = createServerSupabase();
  const ensureError = await ensureProfileRow(db, userId);
  if (ensureError)
    return void res.status(500).json({ detail: ensureError.message });

  const { error: updateError } = await db
    .from("user_profiles")
    .update(parsed.update)
    .eq("user_id", userId);
  if (updateError)
    return void res.status(500).json({ detail: updateError.message });

  const { data, error } = await loadProfile(db, userId);
  if (error) return void res.status(500).json({ detail: error.message });
  const apiKeyStatus = await getUserApiKeyStatus(userId, db);
  res.json({ ...data, apiKeyStatus });
});

// GET /user/api-keys
userRouter.get("/api-keys", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const status = await getUserApiKeyStatus(userId, db);
  res.json(status);
});

// PUT /user/api-keys/:provider
userRouter.put("/api-keys/:provider", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const provider = normalizeApiKeyProvider(req.params.provider);
  if (!provider)
    return void res.status(400).json({ detail: "Unsupported provider" });

  const apiKey =
    typeof req.body?.api_key === "string" ? req.body.api_key : null;
  const db = createServerSupabase();
  try {
    if (hasEnvApiKey(provider)) {
      return void res.status(409).json({
        detail:
          "This provider is configured by the server environment and cannot be changed from the browser.",
      });
    }
    await saveUserApiKey(userId, provider, apiKey, db);
    const status = await getUserApiKeyStatus(userId, db);
    res.json(status);
  } catch (err) {
    console.error("[user/api-keys] save failed", {
      provider,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ detail: "Failed to save API key" });
  }
});

// DELETE /user/account
userRouter.delete("/account", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();

  // First, query document_versions to get storage keys before deletion
  let storageKeys: string[] = [];
  if (storageEnabled) {
    // First get document IDs for the user
    const { data: userDocs, error: docsQueryError } = await db
      .from("documents")
      .select("id")
      .eq("user_id", userId);

    if (docsQueryError) {
      console.error(`[user/account] Failed to query documents for user ${userId}:`, docsQueryError);
      return void res.status(500).json({ detail: docsQueryError.message });
    }

    const documentIds = userDocs?.map((doc) => doc.id) ?? [];

    // Then query document_versions for those documents
    const { data: versions, error: versionsQueryError } = documentIds.length > 0
      ? await db
          .from("document_versions")
          .select("storage_path, pdf_storage_path, document_id")
          .in("document_id", documentIds)
      : { data: null, error: null };
    if (versionsQueryError) {
      console.error(`[user/account] Failed to query document_versions for user ${userId}:`, versionsQueryError);
      return void res.status(500).json({ detail: versionsQueryError.message });
    }
    if (versions && Array.isArray(versions)) {
      for (const version of versions as Array<{ storage_path?: string | null; pdf_storage_path?: string | null }>) {
        if (version.storage_path) storageKeys.push(version.storage_path);
        if (version.pdf_storage_path) storageKeys.push(version.pdf_storage_path);
      }
    }

    // Delete storage objects before deleting DB rows
    for (const key of storageKeys) {
      try {
        await deleteFile(key);
      } catch (storageError) {
        console.error(`[user/account] Failed to delete storage key ${key}:`, storageError);
        return void res.status(500).json({
          detail: `Failed to delete storage object: ${storageError instanceof Error ? storageError.message : String(storageError)}`,
        });
      }
    }
  }

  // Perform all deletions/updates sequentially; if any fail, return error immediately
  // This provides basic consistency by halting on first error
  const operations = [
    { name: "user_api_keys", fn: () => db.from("user_api_keys").delete().eq("user_id", userId) },
    { name: "user_profiles", fn: () => db.from("user_profiles").delete().eq("user_id", userId) },
    { name: "hidden_workflows", fn: () => db.from("hidden_workflows").delete().eq("user_id", userId) },
    { name: "workflow_shares", fn: () => db.from("workflow_shares").delete().eq("shared_by_user_id", userId) },
    { name: "tabular_review_chats", fn: () => db.from("tabular_review_chats").delete().eq("user_id", userId) },
    { name: "tabular_reviews", fn: () => db.from("tabular_reviews").delete().eq("user_id", userId) },
    { name: "chats", fn: () => db.from("chats").delete().eq("user_id", userId) },
    { name: "documents", fn: () => db.from("documents").delete().eq("user_id", userId) },
    { name: "project_subfolders", fn: () => db.from("project_subfolders").delete().eq("user_id", userId) },
    { name: "projects", fn: () => db.from("projects").delete().eq("user_id", userId) },
    { name: "workflows", fn: () => db.from("workflows").delete().eq("user_id", userId) },
    { name: "legacy_user_map", fn: () => db.from("legacy_user_map").update({ claimed_user_id: null, claimed_at: null }).eq("claimed_user_id", userId) },
  ];

  for (const operation of operations) {
    const result = await operation.fn();
    if (result.error) {
      console.error(`[user/account] Failed to delete ${operation.name} for user ${userId}:`, result.error);
      return void res.status(500).json({ detail: result.error.message });
    }
  }

  const { error } = await db.auth.admin.deleteUser(userId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});
