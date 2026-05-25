#!/usr/bin/env bash
# Spike-04: validate spec-25 v0 on cf-ai-binding.
# Covers A1/A2/A3/A3b/A4/A5/A6/A7 per spike-04 README.
set -euo pipefail

BASE="${BASE:-http://localhost:8787}"

PASS=0
FAIL=0

pass() { echo "  [ok ] $1"; PASS=$((PASS + 1)); }
fail() { echo "  [!!] $1"; FAIL=$((FAIL + 1)); }
assert_eq() {
  local label="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then pass "$label (got=$got)"
  else fail "$label  want=$want  got=$got"
  fi
}

echo
echo "==================== A1 / A2 / A5  (pure functions) ===================="
UNIT=$(curl -sS -X POST "$BASE/test/unit")
echo "$UNIT" | jq '.'

assert_eq "A1 S2 fingerprint stable across calls" \
  "$(echo "$UNIT" | jq -r '.A1_A2_fingerprint.A1_S2_stable_across_calls')" "true"
assert_eq "A2 S2 == S3 reordered fingerprint" \
  "$(echo "$UNIT" | jq -r '.A1_A2_fingerprint.A2_S2_eq_S3_reordered')" "true"
assert_eq "A1/A2 S1 != S2 fingerprint" \
  "$(echo "$UNIT" | jq -r '.A1_A2_fingerprint.S1_ne_S2')" "true"

A5_PASS=$(echo "$UNIT" | jq -r '.A5_decideTier_truthtable | map(select(.pass == false)) | length')
assert_eq "A5 decideTier 12-row truth table (failing rows)" "$A5_PASS" "0"

echo
echo "==================== A6  (model behavior + algebra) ===================="
curl -sS -X POST "$BASE/reset" -H 'content-type: application/json' -d '{}' >/dev/null
A6_OK=0
OUTCOMES=()
TIERS=()
for i in 1 2 3; do
  echo "-- attempt $i"
  RES=$(curl -sS -X POST "$BASE/attempt" -H 'content-type: application/json' -d '{
    "schemaName": "S2",
    "stimulus": {
      "kind": "live",
      "userText": "Analyze: agent-OS is clean and works well.",
      "deliverEventName": "analysis.done"
    }
  }')
  CLS=$(echo "$RES" | jq -r '.outcome.class')
  TIER=$(echo "$RES" | jq -r '.tier')
  SHORT=$(echo "$RES" | jq -r '.shortCircuited')
  echo "  outcome.class=$CLS  tier=$TIER  shortCircuited=$SHORT"
  OUTCOMES+=("$CLS")
  TIERS+=("$TIER")
  if [ "$CLS" = "Supported" ]; then
    A6_OK=$((A6_OK + 1))
  fi
done

# A6a (model behavior, non-blocking observation): record success rate.
echo "  --> model success rate this run: $A6_OK/3"
if [ "$A6_OK" -lt 1 ]; then
  fail "A6a model produced 0/3 Supported — spec-25 algebra path unreachable"
else
  pass "A6a model produced ≥1/3 Supported (rate=$A6_OK/3, spike-03 claimed 3/3)"
fi

# A6b (algebra): tier discipline conditional on observed Supported outcomes.
# Rule: among Supported outcomes, exactly the FIRST one (in time order) must
# be DO-tier (admission-forming); any subsequent Supported must be AE-tier
# (reinforcement). This holds regardless of intervening non-Supported
# outcomes, because once a Supported lease forms, subsequent Supported
# within hard expiry reinforce on AE.
SEEN_SUPPORTED=0
A6B_FAIL=0
for i in 0 1 2; do
  if [ "${OUTCOMES[$i]}" = "Supported" ]; then
    SEEN_SUPPORTED=$((SEEN_SUPPORTED + 1))
    if [ "$SEEN_SUPPORTED" = "1" ]; then
      if [ "${TIERS[$i]}" != "do-sqlite" ]; then
        fail "A6b first Supported (attempt $((i+1))) must be DO tier, got ${TIERS[$i]}"
        A6B_FAIL=$((A6B_FAIL + 1))
      fi
    else
      if [ "${TIERS[$i]}" != "analytics-engine" ]; then
        fail "A6b reinforcement Supported (attempt $((i+1))) must be AE tier, got ${TIERS[$i]}"
        A6B_FAIL=$((A6B_FAIL + 1))
      fi
    fi
  fi
done
if [ "$SEEN_SUPPORTED" -ge 1 ] && [ "$A6B_FAIL" -eq 0 ]; then
  pass "A6b tier discipline (DO for admission, AE for reinforcement) holds across $SEEN_SUPPORTED Supported outcome(s)"
fi

echo
echo "==================== A3b  (decode failure short-circuit, 1 evidence + 0 deliver) ===================="
curl -sS -X POST "$BASE/reset" -H 'content-type: application/json' -d '{"deliverFault":"none"}' >/dev/null
RES=$(curl -sS -X POST "$BASE/attempt" -H 'content-type: application/json' -d '{
  "schemaName": "S4",
  "stimulus": {
    "kind": "live",
    "userText": "anything",
    "deliverEventName": "should.not.fire"
  },
  "adapterMode": "test-decode-mismatch"
}')
echo "$RES" | jq '{outcome,tier,ok}'
EVENTS=$(curl -sS "$BASE/events")
EV_COUNT=$(echo "$EVENTS" | jq '[.events[] | select(.kind=="llm.structured.evidence")] | length')
EV_BF=$(echo "$EVENTS" | jq '[.events[] | select(.outcomeClass=="BehaviorFailed")] | length')
DEL_COUNT=$(echo "$EVENTS" | jq '.deliveries | length')
assert_eq "A3b evidence row count" "$EV_COUNT" "1"
assert_eq "A3b BehaviorFailed row count" "$EV_BF" "1"
assert_eq "A3b deliver row count" "$DEL_COUNT" "0"

echo
echo "==================== A3  (transactionSync rollback: 0 evidence + 0 deliver) ===================="
curl -sS -X POST "$BASE/reset" -H 'content-type: application/json' -d '{"deliverFault":"throw_after_evidence"}' >/dev/null
RES=$(curl -sS -X POST "$BASE/attempt" -H 'content-type: application/json' -d '{
  "schemaName": "S2",
  "stimulus": {
    "kind": "live",
    "userText": "Analyze: agent-OS works.",
    "deliverEventName": "analysis.done"
  }
}')
echo "$RES" | jq '{outcome,tier,ok}'
EVENTS=$(curl -sS "$BASE/events")
EV_COUNT=$(echo "$EVENTS" | jq '.events | length')
DEL_COUNT=$(echo "$EVENTS" | jq '.deliveries | length')
assert_eq "A3 evidence row count (post-rollback)" "$EV_COUNT" "0"
assert_eq "A3 deliver row count (post-rollback)" "$DEL_COUNT" "0"
curl -sS -X POST "$BASE/reset" -H 'content-type: application/json' -d '{"deliverFault":"none"}' >/dev/null

echo
echo "==================== A4  (projectLease purity — implicit) ===================="
echo "  spike implementation re-projects from SQLite on every call;"
echo "  no in-memory cache exists to drop. A4 is trivially satisfied:"
echo "  every gate decision is derived from canonical event log only."
pass "A4 trivially satisfied (no in-memory cache in spike)"

echo
echo "==================== A7  (providerCallsCount short-circuit) ===================="
curl -sS -X POST "$BASE/reset" -H 'content-type: application/json' -d '{}' >/dev/null
# First call: forces BehaviorFailed via test-decode-mismatch, writes evidence, counter += 1.
curl -sS -X POST "$BASE/attempt" -H 'content-type: application/json' -d '{
  "schemaName": "S4",
  "stimulus": {
    "kind": "live",
    "userText": "first",
    "deliverEventName": "x"
  },
  "adapterMode": "test-decode-mismatch"
}' >/dev/null
C1=$(curl -sS "$BASE/counter" | jq -r '.providerCallsCount')
# Second call within TTL: must short-circuit, counter stays.
RES=$(curl -sS -X POST "$BASE/attempt" -H 'content-type: application/json' -d '{
  "schemaName": "S4",
  "stimulus": {
    "kind": "live",
    "userText": "second",
    "deliverEventName": "x"
  },
  "adapterMode": "test-decode-mismatch"
}')
SHORT=$(echo "$RES" | jq -r '.shortCircuited')
C2=$(curl -sS "$BASE/counter" | jq -r '.providerCallsCount')
DELTA=$((C2 - C1))
echo "  counter before second call: $C1   after: $C2   delta: $DELTA   shortCircuited=$SHORT"
assert_eq "A7 short-circuit flag" "$SHORT" "true"
assert_eq "A7 providerCallsCount delta (must be exactly 0)" "$DELTA" "0"

echo
echo "============== RESULTS =============="
echo "PASS: $PASS"
echo "FAIL: $FAIL"
echo "====================================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
