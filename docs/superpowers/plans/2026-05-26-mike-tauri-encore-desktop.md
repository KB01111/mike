# Mike Tauri Encore Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Mike desktop-compatible with Tauri v2 and Encore.ts, remove remaining Supabase-shaped frontend runtime paths, and verify that the changed stack still supports Mike's main features.

**Architecture:** Keep Mike as a Tauri v2 desktop shell that starts the packaged Next.js sidecar while Encore.ts owns API routing, PostgreSQL migrations, and local/cloud backend runtime. Preserve the backend Postgres compatibility client during this pass to minimize route risk, but make migration layout, API base URL behavior, and frontend local auth naming explicit.

**Tech Stack:** Tauri v2, Next.js 16, React 19, Encore.ts, Express, Encore PostgreSQL, S3-compatible R2 storage, Node.js test runner through `tsx --test`, npm, PowerShell, local Encore CLI.

---

## File Structure

- Modify `backend/src/migrations/001_initial.up.sql`: Encore-discoverable copy of the initial migration.
- Delete `backend/migrations/001_initial.sql`: old migration location outside the Encore service directory.
- Create `backend/src/encoreLayout.test.ts`: verifies the migration lives under the Encore service directory and has the `.up.sql` suffix.
- Create `frontend/src/lib/apiBase.ts`: single frontend helper for resolving the Mike API base URL.
- Move `frontend/src/lib/supabase.ts` to `frontend/src/lib/mikeAuth.ts`: local Mike auth client with no Supabase export name.
- Modify frontend files that import `@/lib/supabase` or inline `NEXT_PUBLIC_API_BASE_URL`: use `mikeAuth` and `getMikeApiBaseUrl`.
- Modify `frontend/scripts/prepare-tauri-sidecar.mjs`: require a configured API base URL for desktop packaged builds and expose `NEXT_PUBLIC_MIKE_DESKTOP_BUILD=1`.
- Modify `frontend/.env.local.example`: document local API base URL and optional desktop build API variable.
- Modify `README.md`: update migration path, Encore validation, desktop dev/build instructions, and Supabase wording.
- Modify `docs/safe-local-testing.md`: align safety instructions with Encore, local auth, and R2.

---

### Task 1: Align Encore Migration Layout

**Files:**
- Create: `backend/src/migrations/001_initial.up.sql`
- Delete: `backend/migrations/001_initial.sql`
- Create: `backend/src/encoreLayout.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write the failing layout test**

Create `backend/src/encoreLayout.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```powershell
rtk npm test --prefix backend -- src/encoreLayout.test.ts
```

Expected: FAIL because `backend/src/migrations` does not exist and `backend/migrations/001_initial.sql` still exists.

- [ ] **Step 3: Move the migration into the Encore service directory**

Run:

```powershell
rtk powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path 'backend\src\migrations' | Out-Null"
rtk powershell -NoProfile -Command "Move-Item -LiteralPath 'backend\migrations\001_initial.sql' -Destination 'backend\src\migrations\001_initial.up.sql'"
rtk powershell -NoProfile -Command "Remove-Item -LiteralPath 'backend\migrations' -Force"
```

- [ ] **Step 4: Update README migration references**

In `README.md`, replace the contents bullet and database setup references:

```md
- `backend/src/migrations/` - Encore PostgreSQL migrations for the `mike` service
```

And update the database setup paragraph to:

```md
Encore applies the ordered `.up.sql` files in `backend/src/migrations/` to the Encore-managed PostgreSQL database for the `mike` service. The first migration creates first-party users, local auth state, the application tables, and the `legacy_user_map` used to claim imported Supabase-owned data by email.
```

- [ ] **Step 5: Run the layout test and backend tests**

Run:

```powershell
rtk npm test --prefix backend -- src/encoreLayout.test.ts
rtk npm test --prefix backend
```

Expected: PASS. If `tsx` is unavailable because dependencies are missing, run `rtk npm install --prefix backend` with approval and repeat both commands.

- [ ] **Step 6: Commit**

Run:

```powershell
rtk git add backend/src/migrations/001_initial.up.sql backend/src/encoreLayout.test.ts README.md
rtk git add -u backend/migrations
rtk git commit -m "fix: align encore migration layout"
```

---

### Task 2: Rename Frontend Local Auth Client

**Files:**
- Move: `frontend/src/lib/supabase.ts` to `frontend/src/lib/mikeAuth.ts`
- Modify: `frontend/src/app/components/assistant/AssistantMessage.tsx`
- Modify: `frontend/src/app/components/assistant/EditCard.tsx`
- Modify: `frontend/src/app/components/shared/DocPanel.tsx`
- Modify: `frontend/src/app/components/shared/DocxView.tsx`
- Modify: `frontend/src/app/hooks/useDocumentVersions.ts`
- Modify: `frontend/src/app/hooks/useFetchDocxBytes.ts`
- Modify: `frontend/src/app/hooks/useFetchSingleDoc.ts`
- Modify: `frontend/src/app/lib/mikeApi.ts`
- Modify: `frontend/src/app/login/page.tsx`
- Modify: `frontend/src/app/signup/page.tsx`
- Modify: `frontend/src/contexts/AuthContext.tsx`

- [ ] **Step 1: Run the frontend Supabase-name scan**

Run:

```powershell
rtk powershell -NoProfile -Command "Get-ChildItem -Path 'frontend\src' -Recurse -Include *.ts,*.tsx | Select-String -Pattern 'supabase|Supabase'"
```

Expected: output includes imports from `@/lib/supabase` and the local-auth client export.

- [ ] **Step 2: Move the local auth client**

Run:

```powershell
rtk powershell -NoProfile -Command "Move-Item -LiteralPath 'frontend\src\lib\supabase.ts' -Destination 'frontend\src\lib\mikeAuth.ts'"
```

- [ ] **Step 3: Rename the exported client and log prefix**

In `frontend/src/lib/mikeAuth.ts`, replace:

```ts
console.error("[supabase] Subscriber callback error:", error);
```

with:

```ts
console.error("[mike-auth] Subscriber callback error:", error);
```

Replace:

```ts
export const supabase = {
```

with:

```ts
export const mikeAuth = {
```

- [ ] **Step 4: Update frontend imports and call sites**

In each frontend file listed in this task, replace:

```ts
import { supabase } from "@/lib/supabase";
```

with:

```ts
import { mikeAuth } from "@/lib/mikeAuth";
```

Then replace every `supabase.auth.` call in those files with `mikeAuth.auth.`.

- [ ] **Step 5: Verify no frontend runtime path imports Supabase naming**

Run:

```powershell
rtk powershell -NoProfile -Command "Get-ChildItem -Path 'frontend\src' -Recurse -Include *.ts,*.tsx | Select-String -Pattern '@/lib/supabase|supabase\.auth|export const supabase|\[supabase\]'"
```

Expected: no output.

- [ ] **Step 6: Run frontend lint**

Run:

```powershell
rtk npm run lint --prefix frontend
```

Expected: PASS. If `eslint` is unavailable because dependencies are missing, run `rtk npm install --prefix frontend` with approval and repeat.

- [ ] **Step 7: Commit**

Run:

```powershell
rtk git add frontend/src/lib/mikeAuth.ts
rtk git add -u frontend/src
rtk git commit -m "refactor: rename frontend local auth client"
```

---

### Task 3: Centralize API Base URL Resolution

**Files:**
- Create: `frontend/src/lib/apiBase.ts`
- Modify: `frontend/src/lib/mikeAuth.ts`
- Modify: `frontend/src/lib/auth.ts`
- Modify: `frontend/src/app/lib/mikeApi.ts`
- Modify: `frontend/src/app/components/assistant/AssistantMessage.tsx`
- Modify: `frontend/src/app/components/assistant/EditCard.tsx`
- Modify: `frontend/src/app/components/shared/DocPanel.tsx`
- Modify: `frontend/src/app/components/shared/DocxView.tsx`
- Modify: `frontend/src/app/hooks/useDocumentVersions.ts`
- Modify: `frontend/src/app/hooks/useFetchDocxBytes.ts`
- Modify: `frontend/src/app/hooks/useFetchSingleDoc.ts`
- Modify: `frontend/scripts/prepare-tauri-sidecar.mjs`
- Modify: `frontend/.env.local.example`

- [ ] **Step 1: Create the API base helper**

Create `frontend/src/lib/apiBase.ts`:

```ts
const DEFAULT_LOCAL_API_BASE_URL = "http://localhost:3001";

function trimTrailingSlash(value: string): string {
    return value.replace(/\/+$/, "");
}

export function getMikeApiBaseUrl(): string {
    const configured = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
    if (configured) return trimTrailingSlash(configured);

    if (process.env.NEXT_PUBLIC_MIKE_DESKTOP_BUILD === "1") {
        throw new Error(
            "NEXT_PUBLIC_API_BASE_URL must be set when building Mike desktop.",
        );
    }

    return DEFAULT_LOCAL_API_BASE_URL;
}
```

- [ ] **Step 2: Use the helper in API/auth files**

In `frontend/src/lib/mikeAuth.ts`, `frontend/src/lib/auth.ts`, and `frontend/src/app/lib/mikeApi.ts`, add:

```ts
import { getMikeApiBaseUrl } from "@/lib/apiBase";
```

Replace each local API base constant:

```ts
const API_BASE =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
```

with:

```ts
const API_BASE = getMikeApiBaseUrl();
```

Use the two-space indentation already present in `frontend/src/lib/auth.ts` for that file.

- [ ] **Step 3: Use the helper in direct download/fetch components**

In every component and hook listed in this task, add:

```ts
import { getMikeApiBaseUrl } from "@/lib/apiBase";
```

Replace inline blocks of:

```ts
process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001"
```

or the same expression split across two lines with:

```ts
getMikeApiBaseUrl()
```

If a local `const API_BASE = ...` exists, keep the constant name and set it to `getMikeApiBaseUrl()`.

- [ ] **Step 4: Require API base for packaged desktop builds**

In `frontend/scripts/prepare-tauri-sidecar.mjs`, insert this block immediately before `run(bin("npm"), ["run", "build"], {`:

```js
const desktopApiBase =
    process.env.NEXT_PUBLIC_API_BASE_URL || process.env.MIKE_DESKTOP_API_BASE_URL;

if (!desktopApiBase) {
    console.error(
        "ERROR: Set NEXT_PUBLIC_API_BASE_URL or MIKE_DESKTOP_API_BASE_URL before building Mike desktop.",
    );
    console.error(
        "Example: $env:MIKE_DESKTOP_API_BASE_URL='https://api.example.com'; npm run desktop:build",
    );
    process.exit(1);
}
```

Then update the build environment block to:

```js
    env: {
        ...process.env,
        MIKE_DESKTOP_BUILD: "1",
        NEXT_PUBLIC_MIKE_DESKTOP_BUILD: "1",
        NEXT_PUBLIC_API_BASE_URL: desktopApiBase,
    },
```

- [ ] **Step 5: Update frontend env example**

Set `frontend/.env.local.example` to:

```env
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001

# Optional alias used by npm run desktop:build when NEXT_PUBLIC_API_BASE_URL is not set.
MIKE_DESKTOP_API_BASE_URL=http://localhost:3001
```

- [ ] **Step 6: Verify API base references are centralized**

Run:

```powershell
rtk powershell -NoProfile -Command "Get-ChildItem -Path 'frontend\src' -Recurse -Include *.ts,*.tsx | Select-String -Pattern 'NEXT_PUBLIC_API_BASE_URL|localhost:3001'"
```

Expected: no output from `frontend/src`. The strings may still appear in `frontend/.env.local.example`, docs, and `frontend/scripts/prepare-tauri-sidecar.mjs`.

- [ ] **Step 7: Run frontend lint**

Run:

```powershell
rtk npm run lint --prefix frontend
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```powershell
rtk git add frontend/src/lib/apiBase.ts frontend/src/lib/mikeAuth.ts frontend/src/lib/auth.ts frontend/src/app/lib/mikeApi.ts frontend/src/app/components/assistant/AssistantMessage.tsx frontend/src/app/components/assistant/EditCard.tsx frontend/src/app/components/shared/DocPanel.tsx frontend/src/app/components/shared/DocxView.tsx frontend/src/app/hooks/useDocumentVersions.ts frontend/src/app/hooks/useFetchDocxBytes.ts frontend/src/app/hooks/useFetchSingleDoc.ts frontend/scripts/prepare-tauri-sidecar.mjs frontend/.env.local.example
rtk git commit -m "fix: make desktop api base explicit"
```

---

### Task 4: Update Desktop and Encore Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/safe-local-testing.md`

- [ ] **Step 1: Update README environment section**

In `README.md`, keep `frontend/.env.local` focused on:

```env
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
```

Add this desktop build note after the frontend env block:

```md
For packaged desktop builds, the build script requires an API URL. Set either `NEXT_PUBLIC_API_BASE_URL` or `MIKE_DESKTOP_API_BASE_URL` before running `npm run desktop:build --prefix frontend`.
```

- [ ] **Step 2: Update README run commands**

Replace the backend run section with:

````md
Start the Encore backend:

```bash
cd backend
encore run
```
````

Replace the desktop shell section with:

````md
For the desktop shell in development:

```bash
npm run desktop:dev --prefix frontend
```

For a packaged desktop build:

```bash
$env:MIKE_DESKTOP_API_BASE_URL="http://localhost:3001"
npm run desktop:build --prefix frontend
```
````

- [ ] **Step 3: Add Encore check command to README useful checks**

Add this command to the Useful Checks list:

```bash
cd backend
encore check "curl /health"
```

- [ ] **Step 4: Update safe local testing docs**

In `docs/safe-local-testing.md`, replace any wording that implies Supabase is runtime infrastructure with Encore, local auth, and R2 wording. Keep migration-only Supabase references only where they describe importing old data.

- [ ] **Step 5: Run docs scans**

Run:

```powershell
rtk powershell -NoProfile -Command "Select-String -Path 'README.md','docs\safe-local-testing.md' -Pattern 'Supabase|supabase'"
```

Expected: matches only in migration/import context, not runtime setup.

- [ ] **Step 6: Commit**

Run:

```powershell
rtk git add README.md docs/safe-local-testing.md
rtk git commit -m "docs: clarify encore desktop setup"
```

---

### Task 5: Reset and Verify Local Encore CLI State

**Files:**
- No repository files unless diagnostics reveal a code issue.

- [ ] **Step 1: Capture current Encore daemon state**

Run:

```powershell
rtk encore daemon env
rtk powershell -NoProfile -Command "Get-Content -LiteralPath \"$env:LOCALAPPDATA\encore\daemon.log\" -Tail 120"
```

Expected: environment paths print. If the daemon log still references `C:\Users\kevin\Projekt\mike\backend`, proceed to the reset step.

- [ ] **Step 2: Stop stale Encore daemon processes**

Run with approval because it affects a user-level background process:

```powershell
rtk powershell -NoProfile -Command "Get-Process encore -ErrorAction SilentlyContinue | Stop-Process"
```

Expected: command exits successfully. It is acceptable if no process exists.

- [ ] **Step 3: Start validation from this worktree**

Run:

```powershell
rtk encore check "curl /health" --timeout 90s
```

Working directory: `backend`

Expected: PASS, and the command output contains the `/health` response with `{"ok":true}`.

- [ ] **Step 4: If Encore still tracks the old checkout, relink this local app**

Run only if Step 3 still reports the old checkout:

```powershell
rtk encore app link mike --force
rtk powershell -NoProfile -Command "Get-Process encore -ErrorAction SilentlyContinue | Stop-Process"
rtk encore check "curl /health" --timeout 90s
```

Expected: PASS from `C:\Users\kevin\.codex\worktrees\b6ea\mike\backend`.

- [ ] **Step 5: Record verification evidence**

If the command passes, copy the key lines into the implementation summary. If it fails for Docker, network, daemon, auth, or dependency reasons, copy the exact error and the latest relevant daemon log lines into the implementation summary.

---

### Task 6: Build and Test the Full Changed Stack

**Files:**
- Modify only if verification exposes a concrete defect.

- [ ] **Step 1: Install missing dependencies if commands are unavailable**

Run only if `tsc`, `tsx`, `eslint`, `next`, or `tauri` commands are missing:

```powershell
rtk npm install --prefix backend
rtk npm install --prefix frontend
```

Expected: installs dependencies from the lockfiles.

- [ ] **Step 2: Run backend verification**

Run:

```powershell
rtk npm run build --prefix backend
rtk npm test --prefix backend
```

Expected: PASS.

- [ ] **Step 3: Run frontend verification**

Run:

```powershell
rtk npm run lint --prefix frontend
rtk npm run build --prefix frontend
```

Expected: PASS.

- [ ] **Step 4: Run desktop sidecar preparation with explicit API base**

Run:

```powershell
rtk powershell -NoProfile -Command "$env:MIKE_DESKTOP_API_BASE_URL='http://localhost:3001'; npm run desktop:prepare-sidecar --prefix frontend"
```

Expected: PASS and output includes `Prepared Tauri sidecar:`.

- [ ] **Step 5: Verify no runtime Supabase frontend references remain**

Run:

```powershell
rtk powershell -NoProfile -Command "Get-ChildItem -Path 'frontend\src' -Recurse -Include *.ts,*.tsx | Select-String -Pattern '@/lib/supabase|supabase\.auth|NEXT_PUBLIC_SUPABASE|SUPABASE_URL|SUPABASE_ANON'"
```

Expected: no output.

- [ ] **Step 6: Verify backend Supabase references are migration or compatibility-only**

Run:

```powershell
rtk powershell -NoProfile -Command "Get-ChildItem -Path 'backend\src' -Recurse -Include *.ts | Select-String -Pattern 'MIGRATION_SUPABASE|createServerSupabase|PostgresSupabaseCompatClient|legacy Supabase'"
```

Expected: output is limited to the migration script and the intentional compatibility client/factory names. No runtime env lookup for `SUPABASE_URL`, `SUPABASE_ANON_KEY`, or `SUPABASE_SERVICE_ROLE_KEY` appears outside the migration script.

- [ ] **Step 7: Commit any verification-driven fixes**

If verification exposes a defect, return to the task that owns the affected files, add an explicit fix step there, rerun that task's verification commands, and commit using that task's commit pattern. Do not bundle unrelated verification fixes into one broad commit.

---

### Task 7: Final Feature-Parity Audit

**Files:**
- No repository files unless the audit finds a defect.

- [ ] **Step 1: Map feature evidence**

Create a final response table with these rows and the evidence source for each:

```md
| Feature area | Evidence |
| --- | --- |
| Local auth signup/login/session/logout | backend tests, frontend import scan, auth routes compile |
| Account profile and API keys | backend build, routes compile, user route uses local auth middleware |
| Projects and folders | backend build, project routes compile |
| Document upload/download/versioning | backend build, document routes compile, storage tests pass |
| Assistant and project chat | backend build, frontend build, chat routes compile |
| Workflows | backend build, workflow routes compile |
| Tabular reviews | backend build, frontend build, tabular routes compile |
| Desktop sidecar | desktop prepare command output |
| Encore CLI setup | `encore check "curl /health"` output or exact blocker |
```

- [ ] **Step 2: Run final git status**

Run:

```powershell
rtk git status --short
```

Expected: clean, unless there are intentionally uncommitted verification artifacts. Do not leave generated binaries staged or untracked.

- [ ] **Step 3: Decide whether the active goal is complete**

Mark the goal complete only if all acceptance criteria in `docs/superpowers/specs/2026-05-26-mike-tauri-encore-desktop-design.md` are proven by current file state and command output. If any command is blocked by environment setup, leave the goal active and report the blocker with exact evidence.
