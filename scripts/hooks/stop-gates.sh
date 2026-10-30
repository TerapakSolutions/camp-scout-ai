#!/usr/bin/env bash
# Stop, GLOBAL — the TURN-END tier. For every repo touched this session (the ledger written by
# track-touched.sh, plus the hook cwd's repo), check the uncommitted TS/JS/Prisma changes:
#   1. map each changed file to its nearest tsconfig.json (root OR nested package) and run that
#      project's local `tsc --noEmit -p tsconfig.json` ONCE per affected project;
#   2. lint each changed TS/JS file with the same classifier as the fast hook.
# BLOCK (exit 2 + stderr) only on real type/lint errors, naming repo + project. Every skip reason
# is a diagnostic (systemMessage on stdout + gates.log), never silence.
#
# Why not verify.sh: Stop fires at the end of EVERY turn; the full suite stays in the verify-gate
# skill at done/PR time. Cheap paths: nothing touched → instant; repo unchanged since the last PASS
# this session → skipped (cache = hash of `git diff HEAD` + untracked names + untracked TS/JS contents).
# Loop-guarded on stop_hook_active. Never installs anything. Settings timeout is 120 s; this keeps an
# internal budget (CLAUDE_GATES_BUDGET, default 100 s) and per-tsc timeout so it finishes inside it.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

input="$(cat)"
printf '%s' "$input" | jq -e '.stop_hook_active == true' >/dev/null 2>&1 && exit 0
sid="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)"
cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)"
gates_init "$sid"

BUDGET="${CLAUDE_GATES_BUDGET:-100}"
TSC_TIMEOUT="${CLAUDE_GATES_TSC_TIMEOUT:-90}"
MAX_LINT_FILES="${CLAUDE_GATES_MAX_LINT_FILES:-25}"
start=$SECONDS

repos=""
[ -n "$cwd" ] && { r="$(find_git_root "$cwd")" && repos="$r"; }
[ -f "$GATES_LEDGER" ] && repos="$(printf '%s\n%s\n' "$repos" "$(cat "$GATES_LEDGER")")"
repos="$(printf '%s\n' "$repos" | grep -v '^$' | sort -u)"
[ -n "$repos" ] || exit 0

BLOCK=""   # accumulated blocking report
DIAG=""    # accumulated non-blocking notices (shown once per key per session)

diag() { # diag <once-key|""> <message>
  gates_log "stop DIAG $2"
  if [ -z "$1" ] || gates_once "$1"; then DIAG="${DIAG}- $2
"; fi
}

state_hash() { # state_hash <repo> — what the cache keys on
  local repo="$1"
  (
    cd "$repo" || exit 0
    git -c core.quotepath=off diff HEAD --no-ext-diff --no-color --binary 2>/dev/null ||
      git -c core.quotepath=off diff --cached --no-ext-diff --no-color --binary 2>/dev/null   # repo with no commits
    git ls-files -z --others --exclude-standard 2>/dev/null | while IFS= read -r -d '' u; do
      printf 'U\0%s\0' "$u"
      case "$u" in *.ts|*.tsx|*.mts|*.cts|*.js|*.jsx|*.mjs|*.cjs|*.prisma) [ -f "$u" ] && cat -- "$u" ;; esac
    done
  ) | shasum -a 256 | cut -d' ' -f1
}

check_repo() {
  local repo="$1" files="" entry xy path orig ext projects="" f tcdir proj tscdir out rc errs
  local repo_block="" cachefile h nlint=0
  [ -d "$repo" ] || { diag "" "skipped $repo: directory no longer exists"; return; }
  git -C "$repo" rev-parse --show-toplevel >/dev/null 2>&1 || { diag "gone:$repo" "skipped $repo: not a git work tree"; return; }
  # The repo ships its own copy of these gates and Claude Code loaded it → that copy checks it.
  repo_gates_own "$repo" && { gates_log "stop $repo: repo ships its own gates (project hooks loaded), global skipped"; return; }

  # Changed files: modified, added, untracked (-uall so a new dir shows its files); deleted ignored.
  while IFS= read -r -d '' entry; do
    xy="${entry:0:2}"; path="${entry:3}"
    case "$xy" in *R*|*C*) IFS= read -r -d '' orig ;; esac
    case "$path" in *.ts|*.tsx|*.mts|*.cts|*.js|*.jsx|*.mjs|*.cjs|*.prisma) ;; *) continue ;; esac
    [ -f "$repo/$path" ] || continue
    files="${files}${path}
"
  done < <(git -C "$repo" -c core.quotepath=off status --porcelain -z -uall 2>/dev/null)
  [ -n "$files" ] || { gates_log "stop $repo: no TS/JS/Prisma changes"; return; }

  cachefile="$GATES_STATE/cache/$(printf '%s' "$repo" | cksum | cut -d' ' -f1)"
  h="$(state_hash "$repo")"
  if [ -f "$cachefile" ] && [ "$(cat "$cachefile")" = "$h" ]; then
    gates_log "stop $repo: unchanged since last pass, skipped"
    return
  fi

  # 1. typecheck — one tsc per affected project
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    tcdir="$(find_up "$repo/$(dirname "$f")" "$repo" tsconfig.json)" ||
      { diag "notsconfig:$repo/$f" "typecheck skipped for $repo/$f: no tsconfig.json between it and the repo root"; continue; }
    printf '%s\n' "$projects" | grep -qxF -- "$tcdir" || projects="${projects}${tcdir}
"
  done <<EOF
$files
EOF

  while IFS= read -r proj; do
    [ -n "$proj" ] || continue
    local label="${proj#"$repo"}"; label="${label#/}"; [ -n "$label" ] || label="(root)"
    if [ $((SECONDS - start)) -ge "$BUDGET" ]; then
      diag "" "typecheck NOT run for $repo [$label]: Stop-gate time budget (${BUDGET}s) used up — run the verify-gate skill"
      continue
    fi
    tscdir="$(find_up "$proj" "$repo" node_modules/.bin/tsc)" ||
      { diag "notsc:$proj" "typecheck skipped for $repo [$label]: no node_modules/.bin/tsc between $proj and the repo root — run npm ci (or the repo's install)"; continue; }
    out="$(cd "$proj" && run_with_timeout "$TSC_TIMEOUT" "$tscdir/node_modules/.bin/tsc" --noEmit -p tsconfig.json 2>&1)"; rc=$?
    gates_log "stop tsc $repo [$label] rc=$rc"
    [ "$rc" -eq 0 ] && continue
    if [ "$rc" -eq 124 ]; then
      diag "" "typecheck TIMED OUT after ${TSC_TIMEOUT}s for $repo [$label] — not blocking; run the verify-gate skill"
      repo_block="${repo_block}__TIMEOUT__"
      continue
    fi
    errs="$(printf '%s\n' "$out" | grep -E 'error TS[0-9]+' | grep -vE 'error TS18003' )"
    if [ -z "$errs" ]; then
      diag "tscodd:$proj:$rc" "tsc exited $rc for $repo [$label] without type errors (config/crash?) — not blocking: $(printf '%s' "$out" | head -n 3 | tr '\n' ' ')"
      repo_block="${repo_block}__TIMEOUT__"   # do not cache an inconclusive run
      continue
    fi
    local tcrel="tsconfig.json"; [ "$label" = "(root)" ] || tcrel="$label/tsconfig.json"
    repo_block="${repo_block}### tsc --noEmit -p $tcrel  [project: $label]
$(truncate_lines 40 "$out")
"
  done <<EOF
$projects
EOF

  # 2. lint changed TS/JS files (same classifier as the fast hook)
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    is_lintable "$f" || continue
    nlint=$((nlint + 1))
    if [ "$nlint" -gt "$MAX_LINT_FILES" ]; then
      diag "" "lint capped at $MAX_LINT_FILES changed files in $repo — run the verify-gate skill for the rest"; break
    fi
    if [ $((SECONDS - start)) -ge "$BUDGET" ]; then diag "" "lint NOT finished for $repo: time budget used up"; repo_block="${repo_block}__TIMEOUT__"; break; fi
    lint_file "$repo/$f" "$repo"
    case "$LINT_VERDICT" in
      ERRORS) repo_block="${repo_block}### eslint $f
$(truncate_lines 20 "$LINT_OUT")
" ;;
      PARSE_GAP) diag "gap:$LINT_KEY" "lint config gap in $LINT_PROJECT: eslint has no TypeScript parser ('Parsing error' on .ts files) — not blocking; tsc covers them" ;;
      CONFIG_ERROR) diag "cfg:$LINT_KEY" "eslint config error in $LINT_PROJECT — lint skipped, not blocking: $(printf '%s' "$LINT_OUT" | head -n 3 | tr '\n' ' ')" ;;
      NO_NODE_MODULES) diag "$LINT_KEY" "lint skipped for $LINT_PROJECT: no node_modules — run npm ci (or the repo's install)" ;;
    esac
  done <<EOF
$files
EOF

  local real="${repo_block//__TIMEOUT__/}"
  if [ -n "$real" ]; then
    BLOCK="${BLOCK}## $repo
${real}"
  elif [ -z "$repo_block" ]; then
    printf '%s' "$h" >"$cachefile"     # cache ONLY a conclusive pass
  fi
}

while IFS= read -r repo; do
  [ -n "$repo" ] || continue
  check_repo "$repo"
done <<EOF
$repos
EOF

if [ -n "$BLOCK" ]; then
  {
    echo "Turn-end quality gate FAILED (uncommitted changes):"
    truncate_lines 60 "$BLOCK"
    [ -n "$DIAG" ] && printf 'Notes:\n%s' "$DIAG"
    echo "↑ fix these before ending the turn (run the verify-gate skill for the full suite)."
  } >&2
  gates_log "stop BLOCK"
  exit 2
fi
[ -n "$DIAG" ] && emit_system_message "Quality gate notes:
$DIAG"
exit 0
