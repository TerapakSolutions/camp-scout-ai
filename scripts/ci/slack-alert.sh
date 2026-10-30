#!/usr/bin/env bash
# Post a CI alert to Slack. Usage: slack-alert.sh "<summary heading>" "<text with \n escapes>"
# Reads the webhook from $SLACK_WEBHOOK (the repo secret SLACK_ALERT_WEBHOOK_URL).
# Copied in shape from merchant-service's "Say so if…" steps (TerapakSolutions/merchant-service ci-cd.yml).
#
# Always exits 0: an alert step must never turn a run's verdict. Every way the alert can be LOST is
# made loud instead, as an ::error annotation, so a lost alert is never a quiet green step.
set -uo pipefail

heading="$1"
text="$2"

# The alert text always lands in the step summary, whatever happens to the POST.
{ echo "### $heading"; echo ""; printf '%b\n' "$text"; } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

if [ -z "${SLACK_WEBHOOK:-}" ]; then
  echo "::error title=Alert not delivered::SLACK_ALERT_WEBHOOK_URL is not available to this run, so this alert was NOT sent to Slack. The text is in the step summary."
  printf 'ALERT (undelivered): %b\n' "$text"
  exit 0
fi

# --fail-with-body is load-bearing: without it curl exits 0 on Slack's 403/404 for a revoked webhook
# and the alert is lost silently. The response is captured, not streamed, so the ::error below
# starts its own line (Slack's error bodies have no trailing newline) and Slack's reason is printed.
if ! resp="$(curl -sS --fail-with-body --max-time 15 -X POST -H 'Content-Type: application/json' \
      --data "$(jq -nc --arg t "$(printf '%b' "$text")" '{text: $t}')" \
      "$SLACK_WEBHOOK" 2>&1)"; then
  printf 'webhook response: %s\n' "$resp"
  echo "::error title=Alert delivery failed::The webhook POST failed, so this alert did NOT reach Slack. curl's reason is on the 'webhook response' line above."
  exit 0
fi
echo "alert sent to Slack"
