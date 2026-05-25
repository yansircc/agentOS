#!/usr/bin/env bash
# insight-helper-agent v0 dogfood e2e — MODEL-DEPENDENT SMOKE TEST.
#
# Validates the substrate carries the interview pattern end-to-end:
#   POST /start              → on(interview.start) → submit → tool.executed
#                                                              with questions
#   POST /answer (mock)      → on(interview.answer) → submit → next turn
#                                                                 or final brief
#
# Status: this script asserts LLM behavior. With Workers AI gpt-oss-120b
# (the current default, the only Workers-AI model with Chat Completions
# shape + tool calling) the tool-call assertion is NOT reliable for the
# generic intent path — the model handles directive intents well but
# tends to reason silently when the intent is open-ended. See README.md
# "Status & limitations" for the substrate-vs-model distinction.
#
# The substrate's wire-level guarantees are validated independently by
# the deterministic contract tests in packages/core/test/, which use a
# stubbed AiBinding Layer and do not depend on any LLM.

set -euo pipefail

BASE="${BASE:-http://localhost:8787}"
SESSION="ih-$(date +%s)"
TOPIC="${TOPIC:-How long can ROVs stay underwater?}"

PASS=0
FAIL=0

log() { echo "==> $*"; }
ok()  { echo "[ok ] $*"; PASS=$((PASS + 1)); }
err() { echo "[!!] $*"; FAIL=$((FAIL + 1)); }

# Poll /events until a predicate (jq filter) matches, or timeout.
# Args: $1 = label, $2 = jq filter that returns >0 length, $3 = timeout seconds.
poll_events() {
  local label="$1" filter="$2" timeout="$3"
  local elapsed=0
  while [ "$elapsed" -lt "$timeout" ]; do
    local events
    events=$(curl -s "$BASE/events/$SESSION")
    local count
    count=$(echo "$events" | jq -r "[.[] | $filter] | length" 2>/dev/null || echo "0")
    if [ "$count" -gt 0 ] 2>/dev/null; then
      echo "$events"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  echo ""
  return 1
}

# Extract the LATEST tool.executed event with name="interview" and return
# its parsed .args.questions array (compact JSON). Empty string on miss.
latest_questions() {
  curl -s "$BASE/events/$SESSION" | jq -c '
    [.[] | select(.kind == "tool.executed" and .payload.name == "interview")]
    | last
    | (.payload.args | fromjson).questions // empty
  '
}

# Given a questions JSON array, build mock answers: for each question,
# select the option whose recommended==true (or the first option if no
# recommended). Returns a JSON object whose keys are the question texts
# and whose values are either a string label (single-select) or an
# array of one label (multi-select).
mock_answers() {
  echo "$1" | jq -c '
    map({
      key: .question,
      value: (
        if .multiSelect then
          [ (.options[] | select(.recommended == true)).label ] // [ .options[0].label ]
        else
          ((.options[] | select(.recommended == true)).label // .options[0].label)
        end
      )
    }) | from_entries
  '
}

# =================================================================
# Step 1: POST /start
# =================================================================
log "POST /start  topic=\"$TOPIC\""
START_RESP=$(curl -s -X POST "$BASE/start" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg s "$SESSION" --arg t "$TOPIC" '{sessionId:$s, topic:$t}')")
echo "$START_RESP" | jq .

START_OK=$(echo "$START_RESP" | jq -r .ok)
START_EVENT_ID=$(echo "$START_RESP" | jq -r .eventId)
if [ "$START_OK" = "true" ]; then
  ok "/start ok=true"
else
  err "/start failed"
  exit 1
fi
if [ "$START_EVENT_ID" -ge 1 ] 2>/dev/null; then
  ok "/start eventId >= 1 ($START_EVENT_ID)"
else
  err "/start eventId invalid"
fi

# =================================================================
# Step 2: wait for first tool.executed (turn 1 questions)
# =================================================================
log "polling for turn-1 tool.executed (max 60s)…"
if poll_events "turn1.tool.executed" \
    'select(.kind == "tool.executed" and .payload.name == "interview")' \
    60 > /dev/null; then
  ok "turn-1 tool.executed (interview) appeared in ledger"
else
  err "turn-1 tool.executed did NOT appear within 60s"
  echo "----- current ledger -----"
  curl -s "$BASE/events/$SESSION" | jq '[.[] | {id, kind}]'
  exit 1
fi

# Parse the turn-1 questions
Q1=$(latest_questions)
if [ -n "$Q1" ] && [ "$Q1" != "null" ] && [ "$Q1" != "empty" ]; then
  Q1_COUNT=$(echo "$Q1" | jq 'length')
  ok "turn-1 questions parsed ($Q1_COUNT question(s))"
  echo "$Q1" | jq -r '.[] | "    - [" + .header + "] " + .question'
else
  err "turn-1 questions args missing or unparsable"
  exit 1
fi

# =================================================================
# Step 3: mock answers + POST /answer
# =================================================================
A1=$(mock_answers "$Q1")
log "POST /answer (mock, picking recommended/first option)"
echo "$A1" | jq .
ANS1_RESP=$(curl -s -X POST "$BASE/answer" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg s "$SESSION" --argjson a "$A1" '{sessionId:$s, answers:$a}')")
echo "$ANS1_RESP" | jq .
ANS1_OK=$(echo "$ANS1_RESP" | jq -r .ok)
if [ "$ANS1_OK" = "true" ]; then
  ok "/answer ok=true"
else
  err "/answer failed"
  exit 1
fi

# =================================================================
# Step 4: wait for turn 2 (either another tool.executed or final brief)
# =================================================================
log "polling for turn-2 outcome (max 60s)…"
COUNT_BEFORE=$(curl -s "$BASE/events/$SESSION" | jq '[.[] | select(.kind == "tool.executed" or (.kind == "interview.turn.delivered" and (.payload.final | tostring | contains("Insight for Writer"))))] | length')

# Poll until either tool.executed count increases, OR a final brief lands
deadline=$((SECONDS + 60))
TURN2_OUTCOME=""
while [ "$SECONDS" -lt "$deadline" ]; do
  EVENTS=$(curl -s "$BASE/events/$SESSION")
  TOOL_COUNT=$(echo "$EVENTS" | jq '[.[] | select(.kind == "tool.executed" and .payload.name == "interview")] | length')
  FINAL_COUNT=$(echo "$EVENTS" | jq '[.[] | select(.kind == "interview.turn.delivered" and (.payload.final | tostring | contains("Insight for Writer")))] | length')

  if [ "$FINAL_COUNT" -gt 0 ] 2>/dev/null; then
    TURN2_OUTCOME="final"
    break
  fi
  if [ "$TOOL_COUNT" -ge 2 ] 2>/dev/null; then
    TURN2_OUTCOME="next_questions"
    break
  fi
  sleep 2
done

if [ "$TURN2_OUTCOME" = "final" ]; then
  ok "turn-2 produced FINAL brief"
elif [ "$TURN2_OUTCOME" = "next_questions" ]; then
  ok "turn-2 produced next question batch"
else
  err "turn-2 produced neither final brief nor next questions within 60s"
  echo "----- current ledger -----"
  curl -s "$BASE/events/$SESSION" | jq '[.[] | {id, kind}]'
fi

# =================================================================
# Step 5: scope isolation sanity — events filter to our session only
# =================================================================
SCOPE_OK=$(curl -s "$BASE/events/$SESSION" | jq -r "[.[] | select(.scope != \"$SESSION\")] | length")
if [ "$SCOPE_OK" = "0" ]; then
  ok "all returned events have scope == $SESSION"
else
  err "ledger returned events from other scopes: $SCOPE_OK"
fi

echo
echo "============== SUMMARY =============="
echo "session: $SESSION"
echo "topic:   $TOPIC"
echo "PASS: $PASS    FAIL: $FAIL"
echo "===================================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
