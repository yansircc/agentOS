#!/usr/bin/env bash
#
# spike-05 e2e — anthropic-messages via aihubmix.
#
# Prereq: `wrangler dev` running in another shell with .dev.vars present.
#
# Verifies the seven algebra claims A1–A7 documented in worker.ts.
# Each curl below records a session-scoped DO and prints the response.

set -u

PORT="${PORT:-8787}"
HOST="http://localhost:${PORT}"

ts=$(date +%s)
SESSION_TURN="turn-${ts}"
SESSION_STRUCTURED="structured-${ts}"
SESSION_AUTH="auth-${ts}"

echo "=========================================="
echo "A1+A7 — routeFingerprint isolation (no aggregator masquerade)"
echo "  Body posted is Anthropic shape (top-level system, tools[].input_schema,"
echo "  tool_choice:{type:tool,name}). Successful Supported below = aihubmix"
echo "  actually speaks Anthropic wire."
echo "=========================================="

echo
echo "=========================================="
echo "A2 — multi-turn tool loop (encodeTurn + decodeTurn + tool result fold)"
echo "=========================================="
curl -sS -X POST "${HOST}/turn?session=${SESSION_TURN}" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"How many times does \"ana\" appear in \"banana cabana ananas\"? Use the counter tool to verify, then state the count."}' \
  | tee /tmp/spike-05-turn.json
echo

echo
echo "=========================================="
echo "A3+A4 — structured submit on Anthropic; adapterId in evidence row"
echo "=========================================="
curl -sS -X POST "${HOST}/structured?session=${SESSION_STRUCTURED}" \
  -H 'Content-Type: application/json' \
  -d '{"text":"I tried the new pasta restaurant downtown last night. The sauce was rich and the staff was friendly, though the wait was long."}' \
  | tee /tmp/spike-05-structured.json
echo

echo "--- events for structured session ---"
curl -sS "${HOST}/events?session=${SESSION_STRUCTURED}" | tee /tmp/spike-05-structured-events.json
echo

echo
echo "=========================================="
echo "A5 — classify on real 401 (bogus credential)"
echo "=========================================="
curl -sS -X POST "${HOST}/test/classify-401?session=${SESSION_AUTH}" \
  -H 'Content-Type: application/json' \
  -d '{}' | tee /tmp/spike-05-auth.json
echo

echo "--- events for auth-test session ---"
curl -sS "${HOST}/events?session=${SESSION_AUTH}" | tee /tmp/spike-05-auth-events.json
echo

echo
echo "=========================================="
echo "A6 — forced-tool-call reliability (5 runs of /structured)"
echo "    Each run uses a fresh session for clean evidence projection."
echo "=========================================="
for i in 1 2 3 4 5; do
  S="rate-${ts}-${i}"
  echo "--- run ${i} ---"
  curl -sS -X POST "${HOST}/structured?session=${S}" \
    -H 'Content-Type: application/json' \
    -d '{"text":"Brief test sample for forced-tool-call reliability run."}' \
    | python3 -c 'import sys,json; r=json.load(sys.stdin); print("ok=",r.get("result",{}).get("ok"),"reason=",r.get("result",{}).get("reason",""))'
done
