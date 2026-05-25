#!/usr/bin/env bash
# v0.2.1 e2e test with hard assertions and proper exit code.
set -euo pipefail

BASE="${BASE:-http://localhost:8787}"
SCOPE="effect-v021-$(date +%s)"
PROMPT="${1:-What time is it now? Use the get_current_time tool.}"

uri_escape() { printf '%s' "$1" | jq -sRr @uri; }
SCOPE_ENC=$(uri_escape "$SCOPE")

PASS=0
FAIL=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "[ok ] $label"
    PASS=$((PASS + 1))
  else
    echo "[!!] $label: expected '$expected', got '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

assert_ge() {
  local label="$1" min="$2" actual="$3"
  if [ "$actual" -ge "$min" ] 2>/dev/null; then
    echo "[ok ] $label ($actual >= $min)"
    PASS=$((PASS + 1))
  else
    echo "[!!] $label: expected >= $min, got '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

echo "==> POST $BASE/submit  scope=$SCOPE"
RESULT=$(curl -s -X POST "$BASE/submit" \
  -H 'content-type: application/json' \
  -d "$(printf '{"scope":"%s","prompt":"%s"}' "$SCOPE" "$PROMPT")")
echo "$RESULT" | jq .

OK_VAL=$(echo "$RESULT" | jq -r .ok)
EVT_COUNT=$(echo "$RESULT" | jq -r .eventCount)
TOKENS_USED=$(echo "$RESULT" | jq -r .tokensUsed)

echo
echo "==> GET $BASE/events/$SCOPE"
EVENTS=$(curl -s "$BASE/events/$SCOPE_ENC")
echo "$EVENTS" | jq '.[] | {id, kind}'

DELIVERED=$(echo "$EVENTS" | jq -r '[.[] | select(.kind == "agent.delivered")] | length')

echo
echo "==> GET $BASE/handler-count/$SCOPE"
COUNT_RES=$(curl -s "$BASE/handler-count/$SCOPE_ENC")
echo "$COUNT_RES" | jq .
HANDLER_COUNT_1=$(echo "$COUNT_RES" | jq -r .count)

echo
echo "==> POST second /submit on same scope (handler count cumulative)"
RESULT2=$(curl -s -X POST "$BASE/submit" \
  -H 'content-type: application/json' \
  -d "$(printf '{"scope":"%s","prompt":"%s"}' "$SCOPE" "$PROMPT")")
echo "$RESULT2" | jq '{ok, eventCount, tokensUsed}'
HANDLER_COUNT_2=$(curl -s "$BASE/handler-count/$SCOPE_ENC" | jq -r .count)

echo
echo "============== ASSERTIONS =============="
assert_eq "submit ok=true"                          "true"  "$OK_VAL"
assert_ge "ledger event count"                      3       "$EVT_COUNT"
assert_ge "agent.delivered events"                  1       "$DELIVERED"
assert_ge "tokens used"                             1       "$TOKENS_USED"
assert_eq "on('agent.delivered') after 1st submit"  "1"     "$HANDLER_COUNT_1"
assert_eq "on('agent.delivered') after 2nd submit"  "2"     "$HANDLER_COUNT_2"
echo "==============================="
echo "PASS: $PASS    FAIL: $FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
