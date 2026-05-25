#!/usr/bin/env bash
# v0.2 e2e test: happy path + on() handler verification.
set -euo pipefail

BASE="${BASE:-http://localhost:8787}"
SCOPE="effect-v02-$(date +%s)"
PROMPT="${1:-What time is it now? Use the get_current_time tool.}"

uri_escape() { printf '%s' "$1" | jq -sRr @uri; }
SCOPE_ENC=$(uri_escape "$SCOPE")

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
EVENTS=$(curl -s "$BASE/events/$SCOPE_ENC")
echo "$EVENTS" | jq '.[] | {id, kind}'

DELIVERED=$(echo "$EVENTS" | jq -r '[.[] | select(.kind == "agent.delivered")] | length')

echo
echo "==> GET $BASE/handler-count/$SCOPE"
COUNT_RES=$(curl -s "$BASE/handler-count/$SCOPE_ENC")
echo "$COUNT_RES" | jq .
HANDLER_COUNT=$(echo "$COUNT_RES" | jq -r .count)

echo
echo "============== ASSERTIONS (v0.2 reactive) =============="
[ "$OK" = "true" ] \
  && echo "[ok ] A1+A3: submit ok=true" \
  || echo "[!!] A1+A3: submit ok=$OK"
[ "$EVT_COUNT" -ge 3 ] \
  && echo "[ok ] A2: ledger has $EVT_COUNT events" \
  || echo "[!!] A2: only $EVT_COUNT events"
[ "$DELIVERED" -ge 1 ] \
  && echo "[ok ] A4: agent.delivered event present" \
  || echo "[!!] A4: agent.delivered missing"
[ "$TOKENS_USED" -gt 0 ] \
  && echo "[ok ] EXTRA: tokensUsed=$TOKENS_USED" \
  || echo "[!!] EXTRA: tokensUsed=$TOKENS_USED"
[ "$HANDLER_COUNT" = "1" ] \
  && echo "[ok ] v0.2: on('agent.delivered') handler fired exactly 1 time" \
  || echo "[!!] v0.2: handlerCount=$HANDLER_COUNT (expected 1)"
echo "========================================================="

echo
echo "==> Second submit, same scope — handler should fire again (count=2)"
SCOPE2_RESULT=$(curl -s -X POST "$BASE/submit" \
  -H 'content-type: application/json' \
  -d "$(printf '{"scope":"%s","prompt":"%s"}' "$SCOPE" "$PROMPT")")
echo "$SCOPE2_RESULT" | jq '{ok, eventCount, tokensUsed}'

COUNT2_RES=$(curl -s "$BASE/handler-count/$SCOPE_ENC")
HANDLER_COUNT2=$(echo "$COUNT2_RES" | jq -r .count)
[ "$HANDLER_COUNT2" = "2" ] \
  && echo "[ok ] v0.2 cumulative: handler fired total 2 times across 2 submits" \
  || echo "[!!] v0.2: handlerCount=$HANDLER_COUNT2 after 2 submits (expected 2)"
