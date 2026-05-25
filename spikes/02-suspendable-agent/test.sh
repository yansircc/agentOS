#!/usr/bin/env bash
# Spike-02 end-to-end test. Assumes `wrangler dev` is running locally on :8787.
set -euo pipefail

BASE="${BASE:-http://localhost:8787}"
SCOPE="spike-02-$(date +%s)"

uri_escape() { printf '%s' "$1" | jq -sRr @uri; }

echo "==> POST /start  scope=$SCOPE"
START=$(curl -s -X POST "$BASE/start" -H 'content-type: application/json' \
  -d "$(printf '{"scope":"%s","topic":"How long can ROVs stay underwater?"}' "$SCOPE")")
echo "$START" | jq .
INSTANCE_ID=$(echo "$START" | jq -r .instanceId)

echo
echo "==> sleep 5  (workflow: init -> ask question -> suspend at waitForEvent)"
sleep 5

echo "==> GET /status/$SCOPE (expect: paused/waiting/running)"
STATUS1=$(curl -s "$BASE/status/$(uri_escape "$SCOPE")")
echo "$STATUS1" | jq .
STATUS1_VAL=$(echo "$STATUS1" | jq -r '.status // empty')

echo
echo "==> GET /events/$SCOPE (expect: interview.started + interview.asked)"
EV1=$(curl -s "$BASE/events/$(uri_escape "$SCOPE")")
echo "$EV1" | jq '.[] | {id, kind}'

echo
echo "==> POST /answer  (sendEvent resumes workflow)"
ANSWER_TEXT="I run an offshore ROV service. Surface-tended vs autonomous changes everything; battery + tether are the two key variables."
curl -s -X POST "$BASE/answer" -H 'content-type: application/json' \
  -d "$(printf '{"scope":"%s","answer":"%s"}' "$SCOPE" "$ANSWER_TEXT")" | jq .

echo
echo "==> sleep 6  (record answer + LLM finalize brief)"
sleep 6

echo "==> GET /events/$SCOPE  (expect: 4 events + brief.written)"
EV2=$(curl -s "$BASE/events/$(uri_escape "$SCOPE")")
echo "$EV2" | jq '[.[] | {id, kind, snippet: (.payload | tostring | .[0:120])}]'

echo
echo "==> GET /status/$SCOPE  (expect: complete)"
STATUS2=$(curl -s "$BASE/status/$(uri_escape "$SCOPE")")
echo "$STATUS2" | jq .
STATUS2_VAL=$(echo "$STATUS2" | jq -r '.status // empty')

KINDS=$(echo "$EV2" | jq -r '.[] | .kind' | tr '\n' ',')

echo
echo "===================== ASSERTIONS ====================="

# B1: paused / waiting after the ask step
if [[ "$STATUS1_VAL" =~ ^(paused|waiting|waitingForEvent|running)$ ]]; then
  echo "[ok ] B1: waitForEvent suspended (status1=$STATUS1_VAL)"
else
  echo "[!!] B1: workflow not suspended (status1=$STATUS1_VAL)"
fi

# B2: instance id == scope
if [ "$INSTANCE_ID" = "$SCOPE" ]; then
  echo "[ok ] B2: instance id = scope ($SCOPE)"
else
  echo "[!!] B2: instance id ($INSTANCE_ID) != scope ($SCOPE)"
fi

# B3: workflow successfully called AI + cross-DO log
if echo "$KINDS" | grep -q "interview.asked" && echo "$KINDS" | grep -q "brief.written"; then
  echo "[ok ] B3: workflow -> AI + cross-DO log succeeded"
else
  echo "[!!] B3: missing interview.asked or brief.written ($KINDS)"
fi

# B4: sendEvent woke the workflow and it completed
if [ "$STATUS2_VAL" = "complete" ] && echo "$KINDS" | grep -q "interview.answered"; then
  echo "[ok ] B4: sendEvent resumed workflow to completion (status2=complete)"
else
  echo "[!!] B4: workflow did not complete (status2=$STATUS2_VAL)"
fi
echo "======================================================"
