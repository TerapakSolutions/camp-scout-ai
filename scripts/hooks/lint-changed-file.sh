#!/usr/bin/env bash
# PostToolUse(Write|Edit), GLOBAL — the FAST tier (< 2 s). Lint ONLY the file just written.
#
#   real lint errors                            → BLOCK (exit 2 + stderr) so Claude fixes them
#   TS file + "Parsing error" only + no TS parser in the repo's eslint config
#                                               → non-blocking "config gap" notice, once per project per session
#   eslint rc=2 (config/internal error)         → non-blocking VISIBLE notice, once per project per session
#   file ignored by the eslint config           → silent
#   no node_modules anywhere above the file     → non-blocking "run npm ci" notice, once per project per session
#   node_modules present but no eslint          → silent (project doesn't use eslint)
#   not a JS/TS file, or no package.json above  → silent
# Never installs anything, never uses a global eslint.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

input="$(cat)"
sid="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)"
f="$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_response.filePath // empty' 2>/dev/null)"
is_lintable "$f" || exit 0
[ -f "$f" ] || exit 0
gates_init "$sid"

stop="$(find_git_root "$f")" || stop=""
# The repo ships its own copy of this gate and Claude Code loaded it → let that copy run, not this one.
[ -n "$stop" ] && repo_gates_own "$stop" && { gates_log "lint $f: repo ships its own gates (project hooks loaded), global skipped"; exit 0; }
lint_file "$f" "$stop"

case "$LINT_VERDICT" in
  ERRORS)
    truncate_lines 60 "$LINT_OUT" >&2
    echo "↑ eslint failed on $f — fix the lint errors before moving on." >&2
    gates_log "lint BLOCK $f"
    exit 2 ;;
  PARSE_GAP)
    gates_log "lint PARSE_GAP $f ($LINT_PROJECT)"
    if gates_once "gap:$LINT_KEY"; then
      emit_post_context "lint skipped (config gap, not your edit): eslint in $LINT_PROJECT has no TypeScript parser, so it reports 'Parsing error' on every .ts file (e.g. $f). TS files there are checked by tsc at turn end instead. Not blocking; shown once per session."
    fi ;;
  CONFIG_ERROR)
    gates_log "lint CONFIG_ERROR $f ($LINT_PROJECT): $(printf '%s' "$LINT_OUT" | head -n 3 | tr '\n' ' ')"
    if gates_once "cfg:$LINT_KEY"; then
      emit_post_context "eslint config error in $LINT_PROJECT (lint skipped, not blocking; shown once per session): $(truncate_lines 8 "$LINT_OUT")"
    fi ;;
  NO_NODE_MODULES)
    gates_log "lint NO_NODE_MODULES $f ($LINT_PROJECT)"
    if gates_once "$LINT_KEY"; then
      emit_post_context "lint skipped for $LINT_PROJECT: no node_modules found above $f — run npm ci (or the repo's package-manager install) to enable the lint and typecheck gates. Not blocking; shown once per session."
    fi ;;
  *) : ;;  # CLEAN, IGNORED, NO_ESLINT, NOT_JS
esac
exit 0
