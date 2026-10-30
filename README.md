# Camp Scout AI

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Camp Scout AI** helps campers discover real Northern California campgrounds using verified seed data from official park and agency sources.

> **Status: work in progress.** This is a RAG learning project — natural-language campsite search grounded in verified campground data. Ingestion, retrieval, and the campground browser are in place; the AI search experience is still rough and the data set is small. Target for a fully working version is **spring 2027**, in time for camping season.
>
> Issues, forks, and PRs are welcome. If you want to move it forward faster than I can, open an issue or reach out — I'm happy to hand off pieces or collaborate. Licensed under [MIT](LICENSE).

## Epic CS-001: Real Seed Foundation

This epic establishes the real-data foundation for Camp Scout AI:

| Story | Status | Description |
|-------|--------|-------------|
| 1. Template Inventory | Done | Routing and component documentation in `docs/TEMPLATE_INVENTORY.md` |
| 2. Rebrand | Done | Camp Scout AI branding throughout the app |
| 3. Real Campground Seed Schema | Done | Schema in `src/data/campgroundSchema.js` |
| 4. Add Real Seed Campgrounds | Done | 20 real NorCal campgrounds in `src/data/campgrounds.js` |
| 5. Campground Browser | Done | Browse page at `/campgrounds` |
| 6. Search and Filters | Done | Search by name/region; filter by amenities and tags |
| 7. Detail Page With Sources | Done | Detail pages with official source and reservation links |
| 8. Availability Not Connected | Done | Notice on every card and detail page |

### Data rules

- **No mock campground data** — seed records use real parks with official `sourceUrl` values.
- **No invented availability** — live booking is not connected; users are directed to official portals.

## Running locally

The app is a Vite + React front end with a small Node API that runs inside the Vite dev server. Everything below works with **no paid accounts**: the database is a local SQLite file, the AI answer provider defaults to a fake that needs no OpenAI key, and the campground data ships in the repo.

### 1. Install and start

```bash
npm ci                                 # Node 20; npm, not pnpm
export SESSION_SECRET=$(openssl rand -hex 16)   # any string >= 16 chars
export CAMP_SCOUT_API_TOKEN=local-dev-token     # any string; shared secret for /api/ask
npm run dev
```

The app runs at [http://localhost:5173](http://localhost:5173). On first API call it creates `./campscout.sqlite` (gitignored) and runs the migrations.

> `SESSION_SECRET` and `CAMP_SCOUT_API_TOKEN` must be **exported in the shell**. The dev server reads only `OPENAI_*`, `STRIPE_*` and `APP_URL` from `.env.local`; everything else comes from the environment.

### 2. Sign in

The whole UI sits behind a Google sign-in gate, and the OAuth routes (`/auth/google`, `/auth/google/callback`) are served only by the production server (`npm start`), not by `npm run dev`. For day-to-day development, mint a session cookie yourself — the same thing the Cypress specs do:

```bash
# prints a signed cs_session token (uses the SESSION_SECRET exported above)
npx tsx -e "import('./src/server/auth/jwt.ts').then(m => console.log(m.signSession({ uid: 'dev', email: 'dev@example.com', name: 'Dev' })))"
```

In the browser on `http://localhost:5173`, open DevTools → Console and run

```js
document.cookie = "cs_session=<paste token>; path=/"; location.reload()
```

You are now signed in as `dev@example.com` for 14 days (or until you change `SESSION_SECRET`).

To use real Google sign-in instead: create an OAuth client (Web application) in Google Cloud Console with redirect URI `http://localhost:8080/auth/google/callback`, then

```bash
export GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... OAUTH_REDIRECT_URL=http://localhost:8080/auth/google/callback
npm run build:fly && npm start      # production server on :8080, serves dist/
```

### 3. What works without keys, and what needs them

| Feature | Without any keys | To turn on for real |
|---|---|---|
| Campground browser, search, filters, detail pages | Works (data in `src/data/campgrounds.js`) | — |
| AI answers (`/api/ask`, retrieval playground) | Works with the **fake provider** (echoes retrieved context, $0) | `OPENAI_ANSWER_PROVIDER=openai` + `OPENAI_API_KEY` in `.env.local`, and `export AI_ENABLED=true` (kill switch, defaults to off); keep the budget limits under "AI Operations" set |
| Recreation.gov facility data (RIDB) | Skipped | `RIDB_API_KEY` (free key from [ridb.recreation.gov](https://ridb.recreation.gov/)) |
| Availability watches + alerts | UI works; nothing polls | `WATCHER_ENABLED=true` plus Twilio / Resend / Pushover credentials (see `.env.example`) |
| Donations | Checkout fails | Stripe test keys + price IDs in `.env.local` |
| Google Analytics | Off | `VITE_GA_MEASUREMENT_ID`; GA only runs on the production host anyway |

`.env.example` lists every variable. Copy it to `.env.local` for the `OPENAI_*` / `STRIPE_*` / `APP_URL` values; export the rest.

**Production (Fly.io):** [https://campscout.terapak.com/](https://campscout.terapak.com/) — see "Fly.io Deployment" below. Deploys come from CI on merge to `main`.

## Testing

```bash
npm test
npm run typecheck   # TypeScript type checking (no emit)
npm run cypress:run   # requires dev server running
```

## TypeScript Workflow

Camp Scout uses an incremental TypeScript migration. JavaScript files remain during the transition; new and migrated modules use `.ts`/`.tsx`.

| Command | Purpose |
|---------|---------|
| `npm run typecheck` | Run `tsc --noEmit` against `src/` |
| `npm test` | Jest unit tests with coverage |
| `npm run build` | Vite production build |

Shared API contracts live in `src/shared/types/api.ts` (Ask/Summary request and response types, citations, evidence, grounding metrics).

Stricter compiler options are tracked in `docs/TYPESCRIPT_STRICTNESS_TODO.md` — each tightening is intended as its own PR.

Configuration (`tsconfig.json`):

- `allowJs: true` — existing `.js`/`.jsx` files stay checkable during migration
- `checkJs: true` — surface type issues in JavaScript without renaming files first
- `noEmit: true` — type-check only; Vite handles bundling

## Project Verification

Run all available quality checks and a production build with one command:

```bash
./scripts/verify.sh
```

The script detects available npm scripts from `package.json` and runs, in order:

1. **Typecheck** — `npm run typecheck` (if defined)
2. **Lint** — `npm run lint` (if defined)
3. **Unit tests** — `npm run test:unit`, `unit`, or `test` (first found)
4. **Coverage** — separate `coverage`, `test:coverage`, or `test:ci` script if defined; otherwise notes when `test` already includes coverage
5. **Production build** — `npm run build` (required)

Behavior:

- Stops immediately on the first failing step
- Prints clear pass/fail sections for each step
- Exits with a non-zero status on failure
- Performs no git, deployment, or release actions

Use this before commits and deployments to validate the project.

## Working with Claude Code in this repo

The repo ships its own Claude Code configuration, so every collaborator gets the same lint and
typecheck guardrails: `CLAUDE.md` (repo rules), `.claude/settings.json` (three hooks) and
`scripts/hooks/` (the scripts they run). Nothing depends on anyone's home directory.

### What runs, and when

| Hook | Event | Blocks | Warns (non-blocking, once per session) |
|------|-------|--------|----------------------------------------|
| `lint-changed-file.sh` | after every `Write`/`Edit` | real eslint errors in the file just written: Claude sees them and must fix them | eslint config gap (no TS parser, so `.ts` files only "Parsing error"); eslint config error; no `node_modules` ("run npm ci") |
| `track-touched.sh` | after every tool call | never | never. It records which git repos the session touched (file paths, `cd <dir>` and `git -C <dir>` in Bash commands) in `$TMPDIR/claude-gates/<session>/repos` |
| `stop-gates.sh` | end of every turn (`Stop`) | `tsc --noEmit` type errors, or eslint errors, in **uncommitted** TS/JS changes of any touched repo. The turn continues until they are fixed | tsc missing, tsc timeout (90 s), lint capped at 25 files, time budget (100 s) used up |

- Edits made through Bash (`sed -i`, scripts) are not linted at write time, but the Stop gate still
  catches them because it checks `git status`, not the tool that made the change.
- The Stop gate skips a repo whose diff is unchanged since its last pass in the same session.
- Diagnostics are also logged to `$TMPDIR/claude-gates/<session>/gates.log`.
- Messages that say "run the verify-gate skill" mean: run `bash scripts/verify.sh`.

### What the trust prompt is asking you to allow

The first time you open this folder, Claude Code asks whether to trust the project settings.
Accepting lets it run these three commands, and nothing else, on your machine:

```
bash "$CLAUDE_PROJECT_DIR"/scripts/hooks/lint-changed-file.sh   # PostToolUse Write|Edit, 60 s timeout
bash "$CLAUDE_PROJECT_DIR"/scripts/hooks/track-touched.sh       # PostToolUse (all tools), 5 s timeout
bash "$CLAUDE_PROJECT_DIR"/scripts/hooks/stop-gates.sh          # Stop, 120 s timeout
```

They run the repo's own `node_modules/.bin/eslint` and `node_modules/.bin/tsc` and read git state.
They never install anything, use a global eslint, touch the network, or change your files.
`.claude/settings.json` sets no permissions, model, environment or MCP servers.

### Required tools

`bash`, `git`, `jq` and `perl` on your `PATH` (perl provides the tsc timeout; macOS has no
`timeout`), plus `npm ci` so `node_modules` exists. Without `node_modules` the hooks only print a
"run npm ci" notice. Without `jq` the hooks cannot read their input and silently do nothing.
Without `perl` the Stop gate cannot run `tsc` under its timeout, so it falls back to lint only (with a
non-blocking note): type errors are then caught by `bash scripts/verify.sh` and CI, not by the hook.

### Opting out locally

Personal overrides go in `.claude/settings.local.json` (gitignored, along with `.claude/*.local.*`).
To switch off every hook for yourself in this repo (this also silences any hooks from your own
user settings while you work here):

```json
{ "disableAllHooks": true }
```

### Intentionally not in the repo

- **The maintainer's personal PR-review gate** (a pre-`gh pr create` hook tied to his own review
  workflow). The PR contract here is the CI `verify` job instead: it is a required status check on
  `main` (a PR can't merge until it passes) and a red run stops the deploy. The `mainprotect` ruleset
  blocks branch deletion and force-push.
- **Terminal status integrations** (iTerm2 status hooks): personal, machine-specific.
- **MCP servers**: none are needed to work on this repo.
- `scripts/hooks/` is copied from the maintainer's global hooks; `scripts/hooks/SOURCE` records the
  commit and a sha256 per file so drift is visible. Update by re-copying, not by editing in place.

## Fly.io Deployment

`campscout.terapak.com` is served from Fly.io. A 502 Bad Gateway usually means the Fly app has no healthy machine running.

> **Production deploys come from CI only.** Merging to `main` runs `verify` and then `flyctl deploy` (`.github/workflows/ci.yml`). Do not run `fly deploy` by hand against the `campscout` app; the commands below are for local builds and one-time setup.

```bash
# One-time: install Fly CLI and authenticate
# https://fly.io/docs/hands-on/install-flyctl/

# Build and run locally (root base path, dist/ output)
npm run build:fly
npm start

# Deploy to Fly (from repo root; requires fly auth)
fly deploy

# Set OpenAI secrets for live AI answers (optional; defaults to fake provider)
fly secrets set OPENAI_ANSWER_PROVIDER=openai OPENAI_API_KEY=sk-... OPENAI_MODEL=gpt-4o-mini
```

Health check: `GET /health` returns `{"status":"ok"}`.

## AI Operations

Camp Scout AI includes production operational controls for cost management, observability, and safety. See `docs/AI_OPERATIONS_RUNBOOK.md` for full procedures.

### Global Kill Switch

Set `AI_ENABLED=false` (default) to disable all OpenAI traffic. The fake provider is used automatically and no network requests are sent to OpenAI.

```bash
# Disable OpenAI immediately (default)
AI_ENABLED=false

# Enable OpenAI (requires OPENAI_ANSWER_PROVIDER=openai and OPENAI_API_KEY)
AI_ENABLED=true
```

### Budget Limits

Configure daily and hourly limits via environment variables. When exceeded, AI endpoints return HTTP 503 and budget events are logged.

| Variable | Purpose |
|----------|---------|
| `AI_DAILY_REQUEST_LIMIT` | Max requests per UTC day |
| `AI_DAILY_INPUT_TOKEN_LIMIT` | Max input tokens per day |
| `AI_DAILY_OUTPUT_TOKEN_LIMIT` | Max output tokens per day |
| `AI_DAILY_DOLLAR_LIMIT` | Max estimated spend per day (legacy alias) |
| `AI_DAILY_BUDGET_USD` | Max estimated spend per day (preferred) |
| `AI_MAX_PROMPT_TOKENS` | Log WARN when a request exceeds this prompt token count |
| `AI_MAX_REQUEST_COST_USD` | Log WARN when a request exceeds this estimated cost |
| `AI_SLOW_REQUEST_MS` | Log WARN when a request exceeds this latency |
| `AI_HOURLY_REQUEST_LIMIT` | Max requests per UTC hour |
| `AI_HOURLY_TOKEN_LIMIT` | Max tokens per hour |
| `AI_HOURLY_DOLLAR_LIMIT` | Max estimated spend per hour |

### Internal Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /metrics` | None | Prometheus-compatible AI metrics |
| `GET /api/ai/dashboard` | API token | Spend dashboard and endpoint monitoring |
| `GET /api/ai/audit?limit=N` | API token | Recent AI audit log entries |
| `GET /api/ai/reconciliation` | API token | Cost reconciliation report |

All responses include an `x-correlation-id` header for end-to-end request tracing.

### Maintenance Mode

Set `AI_MAINTENANCE_MODE=true` to return HTTP 503 on AI endpoints. The health check at `/health` is unaffected.

## Project Structure

See `docs/TEMPLATE_INVENTORY.md` for the full routing and component inventory.

## Built With

- [React](https://react.dev/)
- [TypeScript](https://www.typescriptlang.org/)
- [Vite](https://vitejs.dev/)
- [Tailwind CSS](https://tailwindcss.com/)
- [React Router](https://reactrouter.com/)
- [Jest](https://jestjs.io/) + [Cypress](https://www.cypress.io/)
