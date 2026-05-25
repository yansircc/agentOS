#!/usr/bin/env bash
# spike-01-effect e2e: wire-level smoke tests only.
#
# Quota state machine is validated deterministically in
# packages/core/test/quota-contract.test.ts (no LLM dependence).
# This script validates the production wire: submit → ledger →
# on-handler → scheduleEvent → alarm → fired event.
set -euo pipefail

BASE="${BASE:-http://localhost:8787}"
SCOPE="effect-v023-$(date +%s)"
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

# ====================== Test 1: agent submit + on() ======================
echo "==> POST /submit"
RESULT=$(curl -s -X POST "$BASE/submit" \
  -H 'content-type: application/json' \
  -d "$(printf '{"scope":"%s","prompt":"%s"}' "$SCOPE" "$PROMPT")")
echo "$RESULT" | jq '{ok, runId, eventCount, tokensUsed}'

OK_VAL=$(echo "$RESULT" | jq -r .ok)
EVT_COUNT=$(echo "$RESULT" | jq -r .eventCount)
HANDLER_COUNT_1=$(curl -s "$BASE/handler-count/$SCOPE_ENC" | jq -r .count)

# ====================== Test 2: scheduleEvent + fire ======================
echo
echo "==> POST /schedule (delay 2000ms)"
SCHED=$(curl -s -X POST "$BASE/schedule" \
  -H 'content-type: application/json' \
  -d "$(printf '{"scope":"%s","delayMs":2000,"event":"test.scheduled","data":{"marker":"%s"}}' "$SCOPE" "$SCOPE")")
echo "$SCHED" | jq .

echo "==> sleep 4 (wait for alarm)"
sleep 4

echo "==> GET /events/$SCOPE (expect test.scheduled to appear)"
EVENTS_AFTER=$(curl -s "$BASE/events/$SCOPE_ENC")
echo "$EVENTS_AFTER" | jq '.[] | {id, kind}'

SCHEDULED_IN_LEDGER=$(echo "$EVENTS_AFTER" | jq -r '[.[] | select(.kind == "test.scheduled")] | length')
SCHED_FIRED_COUNT=$(curl -s "$BASE/scheduled-fired-count/$SCOPE_ENC" | jq -r .count)

# ====================== Idempotency: second alarm (manual replay-style) ====
# We can't easily force the DO to re-fire its alarm in dev. Skip explicit
# idempotency test; the UPDATE ... AND fired_event_id IS NULL guard
# guarantees it by construction.

# ====================== Test 3: withQuota rate-limit ======================
# REMOVED — was LLM-dependent (3 submits assumed the LLM would call
# get_current_time each time; reviewer's 2026-05-25 run hit 6/8 because
# submit 1 returned plain text). The quota state machine is now validated
# deterministically by packages/core/test/quota-contract.test.ts using
# a stubbed AiBinding Layer. This e2e keeps only the LLM-independent
# wire-level smoke tests (submit ok / events written / on-handler fired /
# scheduleEvent atomic fire).

echo
echo "============== ASSERTIONS =============="
assert_eq "submit ok=true"                          "true"  "$OK_VAL"
assert_ge "ledger event count after submit"         3       "$EVT_COUNT"
assert_eq "on('agent.delivered') after 1st submit"  "1"     "$HANDLER_COUNT_1"
assert_ge "scheduled event landed in ledger"        1       "$SCHEDULED_IN_LEDGER"
assert_eq "on('test.scheduled') fired exactly 1 time" "1"   "$SCHED_FIRED_COUNT"
echo "==============================="
echo "PASS: $PASS    FAIL: $FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
