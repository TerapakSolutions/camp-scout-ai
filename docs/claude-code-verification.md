# Claude Code config: clean-clone verification (2026-10-30)

**Method.** Real headless Claude Code sessions. The hook scripts were not driven by hand.
- `git clone` of branch `chore/portable-claude-config` at commit `1170a69` (this file was added
  afterwards) into `$TMPDIR/cs-clean`, then `CYPRESS_INSTALL_BINARY=0 npm ci` (963 packages, 18 s,
  a real install, not a symlink).
- Claude Code 2.1.314, run from the clone with the parent session's `CLAUDE*` env vars unset:
  `claude -p --setting-sources project --output-format stream-json --verbose --include-hook-events
  --no-session-persistence --permission-mode acceptEdits --allowedTools "<per run>"`, prompt on stdin.
  The `--allowedTools` value was `Read,Edit` (c), `Bash(sed *),Read` (b) and `Read` (d), so no
  session could run anything beyond what it was asked to. The clone was reset with
  `git checkout -- .` between sessions.
- The clone is under `$TMPDIR`, outside `~/mycode`, so no parent-directory `CLAUDE.md` applied.

## (a) Edit a `.ts` file → config-gap note, no block ✅
`PostToolUse:Edit` lint hook, exit 0:
```
{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"lint skipped (config gap, not your edit): eslint in …/cs-clean has no TypeScript parser, so it reports 'Parsing error' on every .ts file (e.g. …/cs-clean/src/server/api/askRoute.ts). TS files there are checked by tsc at turn end instead. Not blocking; shown once per session."}}
```
`Stop`: exit 0. tsc passed, because the edit was only a comment.

## (b) Bash `sed` introduces a type error → Stop blocks ✅
The sed edit went through Bash, so no lint ran at write time. `PostToolUse:Bash` (track-touched)
exited 0. Then `Stop` exited 2, and the reason Claude received was:
```
[bash "$CLAUDE_PROJECT_DIR"/scripts/hooks/stop-gates.sh]: Turn-end quality gate FAILED (uncommitted changes):
## …/cs-clean
### tsc --noEmit -p tsconfig.json  [project: (root)]
src/server/api/askRoute.ts(48,14): error TS2322: Type 'string' is not assignable to type 'number'.
src/server/api/askRoute.ts(271,9): error TS2367: This comparison appears to be unintentional because the types 'string' and 'number' have no overlap.

Notes:
- lint config gap in …/cs-clean: eslint has no TypeScript parser ('Parsing error' on .ts files) — not blocking; tsc covers them
↑ fix these before ending the turn (run the verify-gate skill for the full suite).
```
The second `Stop` (`stop_hook_active`) exited 0, so the loop guard held. `HEALTH_ROUTE_PATH` is on
line 48.

## (c) Unused variable in a `.jsx` → lint blocks ✅
After an Edit to `src/components/AvailabilityNotice.jsx`, the `PostToolUse:Edit` lint hook exited 2:
```
…/cs-clean/src/components/AvailabilityNotice.jsx
  3:7  error  'portabilityUnused' is assigned a value but never used  no-unused-vars
✖ 1 problem (1 error, 0 warnings)
↑ eslint failed on …/AvailabilityNotice.jsx — fix the lint errors before moving on.
```
Claude had been told not to fix it, so `Stop` then also exited 2 with the same `no-unused-vars`
error under `### eslint src/components/AvailabilityNotice.jsx`.

## (d) "What is this repo's deploy rule?" → answers from CLAUDE.md ✅
The session used no tools. Its final answer:
> Merging to `main` deploys to production. On every push to `main`, the CI `deploy` job (`needs: verify`) runs `flyctl deploy --app campscout` and then smoke-checks `https://campscout.terapak.com/health`. Never run `fly deploy` by hand; prod once drifted 52 commits from `main` because of laptop hand-deploys. Work on a branch and open a PR. A red `verify` stops the deploy but doesn't block the merge, because `verify` isn't a required status check (the `mainprotect` ruleset only blocks branch deletion and force-push).
>
> **Source:** `CLAUDE.md`, the "Branch and deploy model" section. It describes `.github/workflows/ci.yml`, but I didn't open that file to check it.

## User and global settings were NOT loaded
The string `cc-status` never appears in the stream, even when user settings are loaded, so its
absence proves nothing. The evidence below comes from hook counts against a **control** run, which
used the same clone and flags but no `--setting-sources`:

| | project only (a) | control (user + project) |
|---|---|---|
| hooks per `PostToolUse:Read` | 1 (project track-touched) | 4 (project + global track-touched, iTerm2 status, one plugin hook) |
| `SessionStart` / `UserPromptSubmit` / `PreToolUse` hooks | none | present (user-level iTerm2 status hooks) |
| MCP servers | none | debug-mcp, claude.ai connectors |
| non-builtin plugins | none | shopify-plugin |

The only home-directory path anywhere in the project-only streams is the auto-memory dir for the new
temp project (`~/.claude/projects/-private-var-…-cs-clean`), which is empty.
