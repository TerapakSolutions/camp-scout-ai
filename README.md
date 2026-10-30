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

## Getting Started

```bash
npm install
npm run dev
```

The app runs at [http://localhost:5173](http://localhost:5173).

**GitHub Pages:** [https://terapaksolutions.github.io/camp-scout-ai/campgrounds](https://terapaksolutions.github.io/camp-scout-ai/campgrounds)

**Production (Fly.io):** [https://campscout.terapak.com/](https://campscout.terapak.com/)

> The old `/smartapp-ui-kit/` URL is no longer valid. Use `/camp-scout-ai/` on GitHub Pages or `/campgrounds` locally.

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

## Fly.io Deployment

`campscout.terapak.com` is served from Fly.io. A 502 Bad Gateway usually means the Fly app has no healthy machine running.

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
