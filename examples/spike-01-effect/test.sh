#!/usr/bin/env bash
# Effect-rewritten spike-01 e2e test. Mirrors spikes/01-minimum-loop/test.sh.
set -euo pipefail

BASE="${BASE:-http://localhost:8787}"
SCOPE="effect-01-$(date +%s)"
PROMPT="${1:-What time is it now? Use the get_current_time tool.}"

uri_escape() { printf '%s' "$1" | jq -sRr @uri; }

echo "==> POST $BASE/submit  scope=$SCOPE"
RESULT=$(curl -s -X POST "$BASE/submit" \
  -H 'content-type: application/json' \
  -d "$(printf '{"scope":"%s","prompt":"%s"}' "$SCOPE" "$PROMPT")")

echo "$RESULT" | jq .

OK=$(echo "$RESULT" | jq -r .ok)
EVT_COUNT=$(echo "$RESULT" | jq -r .eventCount)
TOKENS_USED=$(echo "$RESULT" | jq -r .tokensUsed)

echo
echo "==> GET $BASE/events/$SCOPE"
EVENTS=$(curl -s "$BASE/events/$(uri_escape "$SCOPE")")
echo "$EVENTS" | jq '.[] | {id, kind}'

DELIVERED=$(echo "$EVENTS" | jq -r '[.[] | select(.kind == "agent.delivered")] | length')

echo
echo "============== ASSERTIONS (Effect rewrite) =============="
[ "$OK" = "true" ] \
  && echo "[ok ] EFF-A1+A3: submit ok=true (Effect→Promise boundary works)" \
  || echo "[!!] EFF-A1+A3: submit ok=$OK"
[ "$EVT_COUNT" -ge 3 ] \
  && echo "[ok ] EFF-A2: ledger has $EVT_COUNT events (Effect-typed log via DO SQLite)" \
  || echo "[!!] EFF-A2: only $EVT_COUNT events"
[ "$DELIVERED" -ge 1 ] \
  && echo "[ok ] EFF-A4: agent.delivered event present (deliver-event logged)" \
  || echo "[!!] EFF-A4: agent.delivered missing"
[ "$TOKENS_USED" -gt 0 ] \
  && echo "[ok ] EFF-EXTRA: tokensUsed=$TOKENS_USED (usage tracking via Effect chain)" \
  || echo "[!!] EFF-EXTRA: tokensUsed=$TOKENS_USED"
echo "========================================================="
