#!/usr/bin/env bash
#
# spike-06 e2e — gemini-generate-content via official Google API.
#
# Prereq: `wrangler dev` running with .dev.vars present.

set -u

PORT="${PORT:-8787}"
HOST="http://localhost:${PORT}"

ts=$(date +%s)
SESSION_TURN="turn-${ts}"
SESSION_STRUCTURED="structured-${ts}"
SESSION_AUTH="auth-${ts}"

echo "=========================================="
echo "A2 — multi-turn tool loop"
echo "=========================================="
curl -sS -X POST "${HOST}/turn?session=${SESSION_TURN}" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"How many times does \"ana\" appear in \"banana cabana ananas\"? Use the counter tool."}' \
  | tee /tmp/spike-06-turn.json
echo

echo "=========================================="
echo "A3+A4 — structured submit, evidence adapterId"
echo "=========================================="
curl -sS -X POST "${HOST}/structured?session=${SESSION_STRUCTURED}" \
  -H 'Content-Type: application/json' \
  -d '{"text":"I tried the new pasta restaurant downtown last night. The sauce was rich and the staff was friendly, though the wait was long."}' \
  | tee /tmp/spike-06-structured.json
echo
echo "--- events ---"
curl -sS "${HOST}/events?session=${SESSION_STRUCTURED}" | tee /tmp/spike-06-structured-events.json
echo

echo "=========================================="
echo "A5 — classify bad credential (Gemini returns HTTP 400 API_KEY_INVALID, NOT 401)"
echo "=========================================="
curl -sS -X POST "${HOST}/test/classify-401?session=${SESSION_AUTH}" \
  -H 'Content-Type: application/json' \
  -d '{}' | tee /tmp/spike-06-auth.json
echo
echo "--- events ---"
curl -sS "${HOST}/events?session=${SESSION_AUTH}" | tee /tmp/spike-06-auth-events.json
echo

echo "=========================================="
echo "A6 — forced-tool-call reliability (5 runs)"
echo "=========================================="
for i in 1 2 3 4 5; do
  S="rate-${ts}-${i}"
  curl -sS -X POST "${HOST}/structured?session=${S}" \
    -H 'Content-Type: application/json' \
    -d '{"text":"Brief test sample run."}' \
    | python3 -c 'import sys,json; r=json.load(sys.stdin); print("run '"$i"': ok=",r.get("result",{}).get("ok"),"reason=",r.get("result",{}).get("reason",""))'
done
