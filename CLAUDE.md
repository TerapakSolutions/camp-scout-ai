# Camp Scout AI — notes for Claude Code

React + Vite front end, Node server (`server/production.mjs`), incremental JS → TS migration.
Single npm package at the repo root (use npm, not pnpm: `package-lock.json` is the lockfile).

## Commands
- `npm ci` — install (CI uses Node 20). The hooks below need `node_modules` to run.
- `npm run lint` — eslint on `src` (`.js`/`.jsx` only)
- `npm run typecheck` — `tsc --noEmit` (root `tsconfig.json`, `allowJs` + `checkJs`)
- `npm test` — jest with coverage
- `npm run build` — vite build + sitemap
- `bash scripts/verify.sh` — typecheck, lint, test, build; stops on the first failure. Run it before
  calling a change done or opening a PR. It does no git or deploy actions.

## Branch and deploy model
- `main` is production. CI (`.github/workflows/ci.yml`) runs the `verify` job on every PR and every
  push to `main`; on a push to `main` the `deploy` job (`needs: verify`) runs
  `flyctl deploy --app campscout` and then smoke-checks `https://campscout.terapak.com/health`.
- **Merging to `main` deploys to prod.** Never run `fly deploy` by hand: before CI deploys, prod
  drifted 52 commits away from `main` because every release was a hand deploy from a laptop branch.
- Work on a branch and open a PR. A red `verify` stops the deploy. It does **not** block the merge:
  `verify` is not a required status check today (the `mainprotect` ruleset only blocks branch
  deletion and force-push).
- Workflow runs from outside contributors need maintainer approval before Actions run them.

## Privacy rules (do not loosen without the owner's say-so)
- GA4 lives in `src/analytics/gaPrivacy.js`, which is unit tested. Consent Mode v2 defaults: analytics
  storage granted, all ad signals denied everywhere; EEA + UK + CH get every signal denied (there is
  no consent banner). `page_location` / `page_path` keep ONLY the query keys `region`, `amenity`,
  `tag`; everything else (Stripe `session_id`, free text, coordinates) is stripped.
  GA only runs on the production host `campscout.terapak.com`.
- `/camp-scout-runtime.js` puts the server's API token in the page ONLY for a signed-in,
  allow-listed session (`sendRuntimeConfigScript` in `src/server/api/askRoute.ts`). Anonymous
  visitors get the runtime object without the token.

## Lint vs typecheck
`.eslintrc.js` has no TypeScript parser: it lints JS/JSX only. TS files are checked by `tsc`
(`npm run typecheck`, and the Stop hook below). An eslint "Parsing error" on a `.ts` file is that
config gap, not your edit.

## Claude Code hooks
`.claude/settings.json` runs `scripts/hooks/` (lint on every Write/Edit; tsc + lint on changed files
at turn end). What each one blocks, required tools and how to opt out: README, "Working with Claude
Code in this repo". The scripts are copies; see `scripts/hooks/SOURCE` before editing them.
