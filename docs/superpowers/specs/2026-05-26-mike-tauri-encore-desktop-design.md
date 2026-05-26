# Mike Tauri v2 and Encore Desktop Compatibility Design

Date: 2026-05-26

## Goal

Make Mike fully compatible with the new desktop stack:

- Tauri v2 provides the desktop shell.
- The packaged desktop UI runs the existing Next.js app as a local sidecar.
- Encore.ts replaces Supabase as the backend application and PostgreSQL owner.
- Mike local auth replaces Supabase auth.
- Existing Mike features keep working through the changed stack.
- The local Encore CLI is configured and verified against this worktree.

## Current State

The repository already contains the core pieces of the migration:

- `frontend/src-tauri` defines a Tauri v2 shell.
- `frontend/scripts/prepare-tauri-sidecar.mjs` builds a standalone Next.js server and packages it as a Tauri sidecar.
- `backend/encore.app`, `backend/src/encore.service.ts`, `backend/src/encore.ts`, and `backend/src/db.ts` define an Encore.ts app with a raw Express fallback endpoint.
- `backend/src/lib/localAuth.ts` and `backend/src/routes/auth.ts` provide first-party email/password sessions.
- `backend/src/lib/postgresClient.ts` keeps existing route code working through a Postgres-backed compatibility client.
- `backend/src/lib/storage.ts` uses S3-compatible R2 storage instead of Supabase Storage.

The main gap is that the Encore app is not yet laid out in the exact shape the local Encore CLI expects. `backend/src/encore.service.ts` makes `backend/src` the Encore service directory, so `migrations: "./migrations"` in `backend/src/db.ts` resolves relative to `backend/src`. The existing migration is in `backend/migrations/001_initial.sql`, which is outside the service directory and does not use Encore's `.up.sql` migration suffix. The local Encore daemon also has stale state pointing at `C:\Users\kevin\Projekt\mike\backend`, so verification must include relinking or restarting Encore against this worktree.

## Architecture

Mike should remain a two-process desktop application:

1. Tauri v2 starts and owns the native desktop window.
2. In packaged desktop builds, Tauri starts the Next.js standalone sidecar on `127.0.0.1:3070` and loads that URL in the webview.
3. The frontend talks to Mike's API through `NEXT_PUBLIC_API_BASE_URL`.
4. Encore.ts owns backend startup, database provisioning, migrations, raw Express routing, and local/cloud runtime behavior.
5. S3-compatible object storage remains the document blob store. The database stores logical object paths.

The desktop app should not bundle Supabase. It also should not depend on Supabase URL or anon/service-role environment variables. Supabase-shaped compatibility names can remain temporarily where they isolate risk, but new code and public docs should describe them as Mike local auth and Postgres compatibility layers.

## Encore Setup

The Encore app should follow Encore.ts conventions:

- Keep the service in `backend/src`, because `backend/src/encore.service.ts` already defines service `mike`.
- Place database migrations inside `backend/src/migrations`.
- Rename the initial migration to an Encore-compatible filename such as `001_initial.up.sql`.
- Keep `backend/src/db.ts` as the database declaration with `new SQLDatabase("mike", { migrations: "./migrations" })`.
- Keep `backend/src/encore.ts` as the raw Express fallback route. The fallback route should be broad enough to preserve existing Express paths during migration.
- Use the local Encore CLI from this machine to validate the app with `encore check`.
- If the Encore daemon tracks an old checkout, stop/restart or relink it so `encore check` runs against `C:\Users\kevin\.codex\worktrees\b6ea\mike\backend`.

## Desktop Runtime

Development and packaged desktop behavior should be explicit:

- Development: run Encore locally with `encore run` from `backend`, run Tauri with `npm run desktop:dev --prefix frontend`, and point `NEXT_PUBLIC_API_BASE_URL` at the Encore API URL.
- Packaged build: Tauri packages and starts only the Next sidecar. The packaged app points to a configured Encore API base URL.
- The desktop app should fail clearly if the API base URL is missing or unreachable, instead of silently behaving like Supabase is still expected.
- Desktop docs should explain that model-provider keys and storage credentials stay backend-side.

Bundling the Encore runtime, local Postgres, and object storage inside the Tauri app is outside this design. That path is significantly heavier and does not match the current Encore-centered architecture.

## Feature Compatibility

The changed stack must preserve these existing user-facing features:

- Sign up, log in, refresh session, and sign out through Mike local auth.
- Account profile and model API key management.
- Project create, read, update, delete, sharing metadata, and people lists.
- Folder creation, renaming, nesting, deletion, and document moves.
- Single-document and project-document uploads.
- Document conversion, PDF viewing, downloads, deletion, and version history.
- Assistant chats, project chats, generated titles, citations, and document edit flows.
- Built-in and user workflows, workflow hiding, sharing, and editing.
- Tabular review creation, table editing, generation, review chat, project-scoped review routes, and Excel export.
- Download tokens and generated document retrieval.

Compatibility should be proven through targeted backend tests, frontend build/lint checks, and at least one local Encore smoke check that reaches `/health`.

## Data Flow

Authentication:

1. The frontend local-auth client stores Mike bearer sessions in browser storage.
2. API requests attach `Authorization: Bearer <token>`.
3. Express auth middleware validates the token with `AUTH_JWT_SECRET`.
4. Routes use `res.locals.userId` and `res.locals.userEmail`.

Database:

1. Routes call the existing `createServerSupabase()` compatibility factory.
2. That factory returns a Postgres-backed client over the Encore `mikeDb` SQLDatabase.
3. The compatibility client translates the subset of Supabase query builder behavior Mike uses into parameterized Postgres SQL.
4. Longer term, route modules can migrate to direct typed SQL helpers, but this design keeps the compatibility layer to minimize feature risk.

Storage:

1. Upload routes store source, PDF, generated, and version files in S3-compatible storage.
2. DB rows store logical paths.
3. `R2_KEY_PREFIX` maps logical paths to a physical object prefix for migrated deployments.
4. Downloads use signed Mike download tokens or S3 presigned URLs depending on the route.

Desktop:

1. Tauri starts the Next sidecar and waits for `127.0.0.1:3070`.
2. The webview loads the local Next app.
3. The Next app calls the configured Encore API base URL.

## Error Handling

- Auth configuration errors should return clear API errors when `AUTH_JWT_SECRET` is missing.
- Download signing should fail clearly when `DOWNLOAD_SIGNING_SECRET` is missing.
- Storage-dependent uploads should fail with an actionable R2/S3 configuration error if storage credentials are absent.
- Desktop startup should report sidecar startup failures instead of opening a blank app.
- The frontend should surface API connectivity failures as Mike API connection problems, not Supabase failures.
- Encore CLI setup issues should be handled by inspecting daemon logs, correcting app tracking, and rerunning `encore check`.

## Testing and Verification

Verification should run in layers:

1. Backend dependency install if needed.
2. Backend typecheck with `npm run build --prefix backend`.
3. Backend tests with `npm test --prefix backend`.
4. Frontend dependency install if needed.
5. Frontend lint with `npm run lint --prefix frontend`.
6. Frontend build with `npm run build --prefix frontend`.
7. Encore validation with `encore check` from `backend`, including at least a `/health` smoke check if the app starts.
8. Desktop build preparation with `npm run desktop:prepare-sidecar --prefix frontend`.

If a verification command cannot run because dependencies, Docker, the Encore daemon, or network access are unavailable, record the exact blocker and the evidence gathered.

## Non-Goals

- Rewriting every Express route as a typed Encore endpoint in this pass.
- Shipping a fully offline desktop app with embedded Postgres and object storage.
- Removing the compatibility database client before feature parity is verified.
- Migrating away from S3-compatible object storage.
- Changing Mike's product workflows or frontend design beyond what is necessary for the stack migration.

## Acceptance Criteria

- Encore migrations are discoverable by the local Encore CLI from this worktree.
- `encore check` no longer fails because migrations are in the wrong directory or named with the wrong suffix.
- No runtime path depends on Supabase credentials for auth, database, or document storage.
- Tauri v2 desktop dev and packaged build paths have explicit API base URL behavior.
- Existing Mike features listed in this design remain backed by the Encore/Postgres/R2/local-auth stack.
- Verification commands either pass or have documented environment blockers with enough evidence to resume.

## References

- Encore.ts service directories: https://encore.dev/docs/ts/primitives/services
- Encore.ts SQL database migrations: https://encore.dev/docs/ts/primitives/databases
- Encore.ts raw and fallback endpoints: https://encore.dev/docs/ts/primitives/defining-apis
