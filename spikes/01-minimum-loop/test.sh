#!/usr/bin/env bash
# Spike-01 end-to-end test. Assumes `wrangler dev` is running locally on :8787.
set -euo pipefail

BASE="${BASE:-http://localhost:8787}"
SCOPE="spike-01-$(date +%s)"
PROMPT="${1:-What time is it now? Use the get_current_time tool.}"

echo "==> POST $BASE/submit  scope=$SCOPE"
RESULT=$(curl -s -X POST "$BASE/submit" \
  -H 'content-type: application/json' \
  -d "$(printf '{"scope":"%s","prompt":"%s"}' "$SCOPE" "$PROMPT")")

echo "$RESULT" | jq .

OK=$(echo "$RESULT" | jq -r .ok)
EVT_COUNT=$(echo "$RESULT" | jq -r .eventCount)
DELIVERED=$(echo "$RESULT" | jq -r .deliveredFired)

echo
echo "==> GET $BASE/events/$SCOPE"
curl -s "$BASE/events/$(printf '%s' "$SCOPE" | jq -sRr @uri)" | jq '.[] | {id, kind, payload}'

echo
echo "===================== ASSERTIONS ====================="
[ "$OK" = "true" ]              && echo "[ok ] A1 + A3: submit returned ok=true (LLM call + DO RPC)" || echo "[!!] A1 or A3: submit ok=$OK"
[ "$EVT_COUNT" -ge 3 ]          && echo "[ok ] A2: ledger has $EVT_COUNT events (>=3)"               || echo "[!!] A2: only $EVT_COUNT events"
[ "$DELIVERED" = "true" ]       && echo "[ok ] A4: on('agent.delivered') fired inside DO"             || echo "[!!] A4: on() callback never fired"
echo "======================================================"
