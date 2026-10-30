#!/usr/bin/env bash
# PostToolUse (ALL tools), GLOBAL — the session ledger. Must stay CHEAP: one jq, no git processes.
#
# Records the git root of every repo this session may have changed, so the Stop gate knows where
# to look even when the session started in a non-git dir (~/mycode) — the bug that kept the old
# Stop typecheck from ever running. Sources:
#   - Write/Edit/MultiEdit/NotebookEdit: tool_input.file_path / notebook_path / tool_response.filePath
#   - Bash: the hook `cwd`, plus every `cd <dir>` and `git -C <dir>` in the command
#     (a fresh agent's cwd stays ~/mycode, so `cd repo && sed -i …` would otherwise be missed)
# Ledger: ${TMPDIR:-/tmp}/claude-gates/<session_id>/repos — one absolute root per line, deduped.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

input="$(cat)"
JQ_PROG="$(cat <<'JQ'
  def unq: sub("^[\"']"; "") | sub("[\"']$"; "");
  (.session_id // ""),
  (.cwd // ""),
  ( if (.tool_name // "") == "Bash" then
      (.cwd // ""),
      ((.tool_input.command // "") | [scan("(?:^|[;&|(\\n]|&&)\\s*cd\\s+(\"[^\"]+\"|'[^']+'|[^\\s;&|)]+)")[0] | unq] | .[]),
      ((.tool_input.command // "") | [scan("\\bgit\\s+-C\\s+(\"[^\"]+\"|'[^']+'|[^\\s;&|)]+)")[0] | unq] | .[])
    else
      (.tool_input.file_path // empty), (.tool_input.notebook_path // empty), (.tool_response.filePath // empty)
    end )
JQ
)"
lines="$(printf '%s' "$input" | jq -r "$JQ_PROG" 2>/dev/null)" || exit 0

sid=""; cwd=""; n=0
while IFS= read -r p; do
  n=$((n + 1))
  if [ "$n" -eq 1 ]; then sid="$p"; gates_init "$sid"; continue; fi
  if [ "$n" -eq 2 ]; then cwd="$p"; continue; fi
  [ -n "$p" ] || continue
  case "$p" in
    "~") p="$HOME" ;;
    "~/"*) p="$HOME/${p#\~/}" ;;
    /*) ;;
    *) [ -n "$cwd" ] && p="$cwd/$p" ;;   # relative cd: resolve against the hook cwd (best effort)
  esac
  root="$(find_git_root "$p")" || continue
  ledger_add "$root"
done <<EOF
$lines
EOF
exit 0
