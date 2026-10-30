# Camp Scout AI — notes for Claude Code

React + Vite front end, Node server (`server/production.mjs`), incremental JS → TS migration.
Single npm package at the repo root (use npm, not pnpm: `package-lock.json` is the lockfile).

## Commands
- `npm ci` — install (CI uses Node 20). The hooks below need `node_modules` to run.
- `npm run lint` — eslint on `src` (`.js`/`.jsx` only)
- `npm run typecheck` — `tsc --noEmit` (root `tsconfig.json`, `allowJs` + `checkJs`)
- `npm test` — jest with coverage; `coverageThreshold` in `jest.config.js` is a floor (fails below it)
- `npm run build` — vite build + sitemap
- `bash scripts/verify.sh` — typecheck, lint, test, build; stops on the first failure, and FAILS (never
  skips) if one of those npm scripts is missing. Run it before calling a change done or opening a PR.
  It does no git or deploy actions.

## Branch and deploy model
- `main` is production. CI (`.github/workflows/ci.yml`) runs `lint`, `typecheck`, `test` and `build`
  as separate jobs on every PR and every push to `main`; the `verify` job aggregates them and passes
  only if all four succeeded. On a push to `main` the `deploy` job (`needs: verify`) runs
  `flyctl deploy --app campscout`, asserts every machine's image label `GH_SHA` (stamped by flyctl
  in Actions) equals that commit, smoke-checks `https://campscout.terapak.com/health/ready` (DB + availability watcher), and checks the
  live bundle still carries the GA4 Measurement ID.
- An `e2e` job runs the Cypress specs against the production build (`build:fly` + `server/production.mjs`,
  signed in via the `mintSession` task). It is NOT in `verify.needs`, so it reports but never blocks.
- `/health/ready` is not a Fly routing check on purpose: with one machine, a failing check takes the
  whole site out of routing. Fly checks `/health` only.
- **Merging to `main` deploys to prod.** Never run `fly deploy` by hand: before CI deploys, prod
  drifted 52 commits away from `main` because every release was a hand deploy from a laptop branch.
- Work on a branch and open a PR. `verify` is a **required status check** on `main` (since
  2026-10-30): a PR can't merge until it passes, and a red run also stops the deploy. Admins aren't
  forced through it, so a direct push to `main` still deploys — don't. The `mainprotect` ruleset
  blocks branch deletion and force-push.
- Workflow runs from outside contributors need maintainer approval before Actions run them.

## How we work
- **TDD, red first**, for fixes and features: write the failing test, and see it fail for the right
  reason before the fix makes it pass.
- **Fixtures come from real captured shapes** (a real API response, a real row), never invented envelopes.
- **Feature flags** carry `REMOVE WHEN / OWNER / REVIEW BY` comments where they are defined.
- **Bugs found but not fixed get logged** with evidence: `~/mycode/platform-status/STATUS.md` in Steve's
  workspace, a GitHub issue for collaborators.
- Run `bash scripts/verify.sh` before a PR. Every change goes through a PR and CI; `verify` is required.

## Privacy rules (do not loosen without the owner's say-so)
- GA4 lives in `src/analytics/gaPrivacy.js`, which is unit tested. Consent Mode v2 defaults: analytics
  storage granted, all ad signals denied everywhere; EEA + UK + CH get every signal denied (there is
  no consent banner). `page_location` / `page_path` keep ONLY the query keys `region`, `amenity`,
  `tag`; everything else (Stripe `session_id`, free text, coordinates) is stripped.
  GA only runs on the production host `campscout.terapak.com`.
- `/camp-scout-runtime.js` puts the server's API token in the page ONLY for a signed-in session
  that passes `isEmailAllowed` (`sendRuntimeConfigScript` in `src/server/api/askRoute.ts`).
  Anonymous visitors get the runtime object without the token.
- **Access is open to any Google account** (since 2026-10-30: the `ALLOWED_EMAILS` Fly secret is
  unset, and `src/server/auth/allowlist.ts` treats "no list" as "everyone"). Setting `ALLOWED_EMAILS`
  (comma-separated) makes the instance private again. With open access, AI spend is bounded only by
  the AI budget limits (README "AI Operations") — keep them set.

## Lint vs typecheck
`.eslintrc.js` has no TypeScript parser: it lints JS/JSX only. TS files are checked by `tsc`
(`npm run typecheck`, and the Stop hook below). An eslint "Parsing error" on a `.ts` file is that
config gap, not your edit.

## Claude Code hooks
`.claude/settings.json` runs `scripts/hooks/` (lint on every Write/Edit; tsc + lint on changed files
at turn end). What each one blocks, required tools and how to opt out: README, "Working with Claude
Code in this repo". The scripts are copies; see `scripts/hooks/SOURCE` before editing them.
