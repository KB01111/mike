# Mike

Mike is a legal document assistant with a Next.js frontend, an Encore.ts-backed Express API, Encore PostgreSQL, Cloudflare R2-compatible object storage, and an optional Tauri v2 desktop shell.

Website: [mikeoss.com](https://mikeoss.com)

## Contents

- `frontend/` - Next.js application and Tauri v2 desktop shell
- `frontend/src-tauri/` - Tauri v2 project that launches the packaged Next sidecar
- `backend/` - Encore.ts app, Express API routes, document processing, and migrations
- `backend/migrations/` - Encore PostgreSQL migrations
- `backend/schema.sql` - legacy Supabase schema reference only

## Prerequisites

- Node.js 20 or newer
- npm
- git
- Encore CLI and an Encore Cloud app for the backend
- A Cloudflare R2 bucket, MinIO bucket, or another S3-compatible bucket
- Rust toolchain if you are building the Tauri desktop app
- At least one supported model provider API key: Anthropic, Google Gemini, or OpenAI
- LibreOffice installed locally if you need DOC/DOCX to PDF conversion

## Database Setup

Encore applies the ordered SQL files in `backend/migrations/` to the Encore-managed PostgreSQL database. The first migration creates first-party users, local auth state, the application tables, and the `legacy_user_map` used to claim imported Supabase-owned data by email.

For migrated deployments, run the one-off migration tool after configuring `DATABASE_URL`, `MIGRATION_SUPABASE_URL`, `MIGRATION_SUPABASE_SERVICE_ROLE_KEY`, R2 credentials, and `R2_KEY_PREFIX`:

```bash
npm run migrate:supabase --prefix backend
```

Use `-- --skip-objects` to import rows and write the migration report without copying R2 objects.

## Environment

Create local env files:

```bash
touch backend/.env
touch frontend/.env.local
```

Create `backend/.env`:

```bash
PORT=3001
FRONTEND_URL=http://localhost:3000
DOWNLOAD_SIGNING_SECRET=replace-with-a-random-32-byte-hex-string
AUTH_JWT_SECRET=replace-with-a-random-32-byte-hex-string
PASSWORD_PEPPER=

R2_ENDPOINT_URL=https://your-account-id.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=your-r2-access-key
R2_SECRET_ACCESS_KEY=your-r2-secret-key
R2_BUCKET_NAME=mike
R2_KEY_PREFIX=mike-v2

GEMINI_API_KEY=your-gemini-key
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key
RESEND_API_KEY=your-resend-key
USER_API_KEYS_ENCRYPTION_SECRET=your-long-random-secret
```

Create `frontend/.env.local`:

```bash
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
```

Provider keys are only needed for the models and email features you plan to use. Model provider keys can be configured in `backend/.env` for the whole instance, or per user in **Account > Models & API Keys**. If a provider key is present in `backend/.env`, that provider is available by default and the matching browser API key field is read-only.

## Install

Install each app package:

```bash
npm install --prefix backend
npm install --prefix frontend
```

## Run Locally

Start the backend:

```bash
cd backend
encore run
```

Start the main app:

```bash
npm run dev --prefix frontend
```

Open `http://localhost:3000`.

For the desktop shell:

```bash
npm run desktop:dev --prefix frontend
npm run desktop:build --prefix frontend
```

Desktop builds create a Next standalone server, package `scripts/mike-next-sidecar.cjs` into a Tauri sidecar binary, bundle the standalone output as a resource, and load `http://127.0.0.1:3070` in the webview.

## First Run

1. Sign up in the app.
2. If you did not set provider keys in `backend/.env`, open **Account > Models & API Keys** and add an Anthropic, Gemini, or OpenAI API key.
3. Create or open a project and start chatting with documents.

## Troubleshooting

**Sign-up fails with a session-secret error.** Set `AUTH_JWT_SECRET` in the backend environment. Local auth signs bearer tokens with this secret.

**The model picker shows a missing-key warning.** Add a key for that provider in **Account > Models & API Keys**, or configure the provider key in `backend/.env` and restart the backend.

**DOC or DOCX conversion fails.** Install LibreOffice locally and restart the backend so document conversion commands are available on the process path.

## Useful Checks

```bash
npm run build --prefix backend
npm run build --prefix frontend
npm run lint --prefix frontend
```
