#!/usr/bin/env bash
# Spike 07 happy path smoke. Requires wrangler dev for this spike to be
# running and OPENROUTER_KEY configured for the structured planning call.

set -euo pipefail

BASE="${BASE:-http://localhost:8787}"
SESSION="ig-$(date +%s)"
USER_ID="user-$(date +%s)"
PROMPT="${PROMPT:-A compact product render of a durable underwater ROV}"

PASS=0
FAIL=0

ok() { echo "[ok ] $*"; PASS=$((PASS + 1)); }
err() { echo "[!!] $*"; FAIL=$((FAIL + 1)); }

poll_session() {
  local filter="$1" timeout="$2"
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    local events count
    events=$(curl -sS "$BASE/events/session/$SESSION")
    count=$(echo "$events" | jq -r "[.[] | $filter] | length" 2>/dev/null || echo "0")
    if [ "$count" -gt 0 ] 2>/dev/null; then
      echo "$events"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 1
}

echo "==> POST /request"
RESP=$(curl -sS -X POST "$BASE/request" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg s "$SESSION" --arg u "$USER_ID" --arg p "$PROMPT" \
    '{sessionId:$s,userId:$u,prompt:$p,nImages:1}')")
echo "$RESP" | jq .

if [ "$(echo "$RESP" | jq -r .ok)" = "true" ]; then
  ok "request accepted"
else
  err "request failed"
  exit 1
fi

echo "==> polling for image.delivered"
if EVENTS=$(poll_session 'select(.kind == "image.delivered")' 90); then
  ok "session ledger has image.delivered"
else
  err "image.delivered not found"
  curl -sS "$BASE/events/session/$SESSION" | jq '[.[] | {id, kind, payload}]'
  exit 1
fi

ARTIFACT_KEY=$(echo "$EVENTS" | jq -r '[.[] | select(.kind == "image.delivered")] | last | .payload.artifactRef.key')
JOB_SCOPE=$(echo "$EVENTS" | jq -r '[.[] | select(.kind == "image.delivered")] | last | .payload.jobScope')
if [ -n "$ARTIFACT_KEY" ] && [ "$ARTIFACT_KEY" != "null" ]; then
  ok "artifact ref recorded: $ARTIFACT_KEY"
else
  err "artifact ref missing"
fi

if curl -sS "$BASE/events/user/$USER_ID" | jq -e '[.[] | select(.kind == "resource.reserved")] | length == 1' >/dev/null; then
  ok "user ledger has resource.reserved"
else
  err "user ledger missing resource.reserved"
fi

if curl -sS "$BASE/events/user/$USER_ID" | jq -e '[.[] | select(.kind == "resource.consumed")] | length == 1' >/dev/null; then
  ok "user ledger has resource.consumed"
else
  err "user ledger missing resource.consumed"
fi

JOB_ID="${JOB_SCOPE#job/}"
if curl -sS "$BASE/events/job/$JOB_ID" | jq -e '[.[] | select(.kind == "image.artifact.written")] | length == 1' >/dev/null; then
  ok "consumer ledger has image.artifact.written"
else
  err "consumer ledger missing image.artifact.written"
fi

echo
echo "PASS: $PASS  FAIL: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
