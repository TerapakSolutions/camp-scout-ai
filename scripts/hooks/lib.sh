#!/usr/bin/env bash
# Shared helpers for the global quality-gate hooks. Sourced, never executed.
# bash 3.2-safe (macOS /bin/bash): no mapfile, no associative arrays, no ${var,,}.
#
# Output channels (Claude Code hook contract, checked against code.claude.com/docs/en/hooks 10-30):
#   - BLOCK                     → stderr + exit 2 (PostToolUse: Claude sees it; Stop: turn continues)
#   - PostToolUse non-blocking  → stdout {"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":…}}, exit 0
#   - Stop / PreToolUse notice  → stdout {"systemMessage":…}, exit 0 (shown to the USER; Stop rendering unverified)
#   - stderr on exit 0 is INVISIBLE to Claude — never put a diagnostic only there.
# Every diagnostic is ALSO appended to $GATES_STATE/gates.log so there is always a durable record.

GATES_HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------- session state ----------
# gates_init <session_id>  → sets GATES_STATE (per-session dir) and creates it.
gates_init() {
  local sid
  sid="$(printf '%s' "${1:-}" | tr -cd 'A-Za-z0-9_.-')"
  [ -n "$sid" ] || sid="nosession"
  GATES_STATE="${TMPDIR:-/tmp}"
  GATES_STATE="${GATES_STATE%/}/claude-gates/$sid"
  mkdir -p "$GATES_STATE/once" "$GATES_STATE/cache" 2>/dev/null || true
  GATES_LEDGER="$GATES_STATE/repos"
}

gates_log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$GATES_STATE/gates.log" 2>/dev/null || true; }

# gates_once <key> → returns 0 the FIRST time a key is seen this session, 1 afterwards.
gates_once() {
  local k
  k="$(printf '%s' "$1" | cksum | cut -d' ' -f1)"
  [ -e "$GATES_STATE/once/$k" ] && return 1
  : >"$GATES_STATE/once/$k" 2>/dev/null
  return 0
}

# Emit JSON (jq handles escaping).
emit_post_context() { jq -cn --arg c "$1" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$c}}'; }
emit_system_message() { jq -cn --arg m "$1" '{systemMessage:$m}'; }

# ---------- discovery ----------
abs_dir() { (cd "$1" 2>/dev/null && pwd -P); }

# repo_gates_own <repo-root> → 0 (true) when THIS script is the GLOBAL copy AND the repo ships its own
# copy of these gates that Claude Code has loaded, so the global run must skip that repo (no double runs).
# "Loaded" = the session's project dir ($CLAUDE_PROJECT_DIR) is inside the repo — project settings only
# load for the directory Claude Code was launched in. A session launched from ~/mycode does NOT load a
# repo's .claude/settings.json, so the global gates keep covering it. The repo's own copy never skips
# itself: its script dir is inside the repo. (CampScout portable config, 2026-10-30.)
repo_gates_own() {
  local root self proj
  root="$(abs_dir "$1")" || return 1
  [ -f "$root/.claude/settings.json" ] || return 1
  grep -q 'scripts/hooks/' "$root/.claude/settings.json" 2>/dev/null || return 1
  self="$(abs_dir "$(dirname "${BASH_SOURCE[0]}")")" || return 1
  case "$self/" in "$root"/*) return 1 ;; esac
  proj="$(abs_dir "${CLAUDE_PROJECT_DIR:-}")" || return 1
  case "$proj/" in "$root"/*) return 0 ;; esac
  return 1
}

# find_git_root <path> — walk up for .git (dir OR file: worktrees/submodules have a .git FILE).
# No git process: this runs on every tool call.
find_git_root() {
  local d="$1"
  [ -d "$d" ] || d="$(dirname "$d")"
  while [ -n "$d" ] && [ ! -d "$d" ]; do d="$(dirname "$d")"; done
  d="$(abs_dir "$d")" || return 1
  while [ -n "$d" ]; do
    [ -e "$d/.git" ] && { printf '%s\n' "$d"; return 0; }
    [ "$d" = "/" ] && return 1
    d="$(dirname "$d")"
  done
  return 1
}

# find_up <startdir> <stopdir|""> <relpath> — nearest ancestor (inclusive) of startdir that contains
# relpath, not walking above stopdir (empty stopdir = filesystem root). Prints the ANCESTOR dir.
find_up() {
  local d="$1" stop="$2" rel="$3"
  d="$(abs_dir "$d")" || return 1
  while [ -n "$d" ]; do
    [ -e "$d/$rel" ] && { printf '%s\n' "$d"; return 0; }
    [ -n "$stop" ] && [ "$d" = "$stop" ] && return 1
    [ "$d" = "/" ] && return 1
    d="$(dirname "$d")"
  done
  return 1
}

ledger_add() {
  local root="$1"
  [ -n "$root" ] || return 0
  grep -qxF -- "$root" "$GATES_LEDGER" 2>/dev/null && return 0
  printf '%s\n' "$root" >>"$GATES_LEDGER"
}

# run_with_timeout <seconds> cmd... — no coreutils `timeout` on macOS; perl is always there.
# Runs the command in its own process group and kills the whole group on expiry. rc 124 = timed out.
run_with_timeout() {
  local t="$1"; shift
  perl -e '
    my $t = shift;
    my $pid = fork();
    if (!defined $pid) { exit 127 }
    if ($pid == 0) { setpgrp(0, 0); exec @ARGV; exit 127 }
    local $SIG{ALRM} = sub { kill "TERM", -$pid; sleep 1; kill "KILL", -$pid; exit 124 };
    alarm $t;
    waitpid($pid, 0);
    my $s = $?;
    exit(($s & 127) ? 128 + ($s & 127) : ($s >> 8));
  ' "$t" "$@"
}

truncate_lines() { # truncate_lines <n> <text>
  local n="$1" text="$2" total
  total="$(printf '%s\n' "$text" | wc -l | tr -d ' ')"
  printf '%s\n' "$text" | head -n "$n"
  [ "$total" -gt "$n" ] && printf '… (%s more lines truncated)\n' "$((total - n))"
  return 0
}

# ---------- eslint classifier (shared by the fast hook and the Stop gate) ----------
# lint_file <file> <stopdir|""> — sets:
#   LINT_VERDICT ∈ CLEAN | ERRORS | PARSE_GAP | CONFIG_ERROR | IGNORED | NO_ESLINT | NO_NODE_MODULES | NOT_JS
#   LINT_OUT     eslint output (ERRORS/CONFIG_ERROR/PARSE_GAP)
#   LINT_PROJECT the package dir eslint ran from;  LINT_KEY a per-project key for once-per-session notices
lint_file() {
  local f="$1" stop="$2" fdir proj bindir bin out rc errlines parselines cfg
  LINT_VERDICT=""; LINT_OUT=""; LINT_PROJECT=""; LINT_KEY=""
  fdir="$(abs_dir "$(dirname "$f")")" || { LINT_VERDICT="NOT_JS"; return; }
  # Project = nearest package.json (the old hook's notion of root). No package.json → not a JS project.
  proj="$(find_up "$fdir" "$stop" package.json)" || { LINT_VERDICT="NOT_JS"; return; }
  LINT_PROJECT="$proj"
  # eslint: nearest node_modules/.bin/eslint walking up — finds hoisted workspace installs.
  bindir="$(find_up "$fdir" "$stop" node_modules/.bin/eslint)"
  if [ -z "$bindir" ]; then
    if find_up "$fdir" "$stop" node_modules >/dev/null; then
      LINT_VERDICT="NO_ESLINT"            # deps installed, eslint simply not used → silent
    else
      LINT_VERDICT="NO_NODE_MODULES"; LINT_KEY="nomods:$proj"
    fi
    return
  fi
  bin="$bindir/node_modules/.bin/eslint"
  LINT_KEY="eslint:$bindir"
  out="$(cd "$proj" && "$bin" "$f" 2>&1)"; rc=$?
  case "$rc" in
    0) LINT_VERDICT="CLEAN"; return ;;
    2)
      if printf '%s' "$out" | grep -qE 'No files matching|File ignored'; then LINT_VERDICT="IGNORED"
      else LINT_VERDICT="CONFIG_ERROR"; LINT_OUT="$out"; fi
      return ;;
    1) ;;
    *) LINT_VERDICT="CONFIG_ERROR"; LINT_OUT="eslint exited $rc: $out"; return ;;
  esac
  # rc=1. Classify the OUTPUT, not just the code.
  errlines="$(printf '%s\n' "$out" | grep -cE '^[[:space:]]*[0-9]+:[0-9]+[[:space:]]+error[[:space:]]')"
  parselines="$(printf '%s\n' "$out" | grep -E '^[[:space:]]*[0-9]+:[0-9]+[[:space:]]+error[[:space:]]' | grep -c 'Parsing error')"
  if [ "$errlines" -gt 0 ] && [ "$errlines" -eq "$parselines" ]; then
    case "$f" in
      *.ts|*.tsx|*.mts|*.cts)
        # Parse-only failure on a TS file: is that a real syntax error, or a config with no TS parser?
        cfg="$(cd "$proj" && "$bin" --print-config "$f" 2>/dev/null)" || { LINT_VERDICT="IGNORED"; return; }
        if printf '%s' "$cfg" | jq -e '[.parser, .languageOptions.parser, .parserOptions.parser,
              .languageOptions.parserOptions.parser] | map(tostring) | join(" ") | test("typescript|babel"; "i")' \
              >/dev/null 2>&1; then
          LINT_VERDICT="ERRORS"; LINT_OUT="$out"       # TS parser present → a real syntax error
        else
          LINT_VERDICT="PARSE_GAP"; LINT_OUT="$out"    # JS-only config asked to parse TS → config gap
        fi
        return ;;
    esac
  fi
  LINT_VERDICT="ERRORS"; LINT_OUT="$out"
}

is_lintable() { case "$1" in *.ts|*.tsx|*.mts|*.cts|*.js|*.jsx|*.mjs|*.cjs) return 0 ;; esac; return 1; }

# ---------- review stamp (shared by review-stamp.sh and pr-gate.sh — ONE definition of the hash) ----------
# default_branch <repo>  → origin's default branch, else "main"
default_branch() {
  local r
  r="$(git -C "$1" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)" && { printf '%s\n' "${r#origin/}"; return; }
  printf 'main\n'
}

stamp_path() { # stamp_path <repo> <branch>
  local common
  common="$(cd "$1" && git rev-parse --git-common-dir 2>/dev/null)" || return 1
  common="$(cd "$1" && cd "$common" && pwd -P)" || return 1
  printf '%s/claude-review/%s.json\n' "$common" "$(printf '%s' "$2" | sed 's#/#__#g')"
}

# review_compute <repo> <base> <branch> — sets RS_BASE_REF RS_MB RS_HEAD_SHA RS_DIFF_SHA RS_NOTE; rc≠0 + RS_ERR on failure.
review_compute() {
  local repo="$1" base="$2" branch="$3"
  RS_BASE_REF=""; RS_MB=""; RS_HEAD_SHA=""; RS_DIFF_SHA=""; RS_NOTE=""; RS_ERR=""
  if git -C "$repo" rev-parse -q --verify "refs/remotes/origin/$base^{commit}" >/dev/null 2>&1; then
    RS_BASE_REF="origin/$base"
  elif git -C "$repo" rev-parse -q --verify "refs/heads/$base^{commit}" >/dev/null 2>&1; then
    RS_BASE_REF="$base"; RS_NOTE="origin/$base not found; used local $base (run git fetch for an exact match)"
  else
    RS_ERR="base branch '$base' not found as origin/$base or a local branch"; return 1
  fi
  RS_HEAD_SHA="$(git -C "$repo" rev-parse -q --verify "refs/heads/$branch^{commit}" 2>/dev/null)" ||
    { RS_ERR="branch '$branch' not found locally"; return 1; }
  RS_MB="$(git -C "$repo" merge-base "$RS_BASE_REF" "$RS_HEAD_SHA" 2>/dev/null)" ||
    { RS_ERR="no merge-base between $RS_BASE_REF and $branch"; return 1; }
  RS_DIFF_SHA="$(git -C "$repo" -c core.quotepath=off diff --no-ext-diff --no-color --binary "$RS_MB..$RS_HEAD_SHA" | shasum -a 256 | cut -d' ' -f1)"
}
