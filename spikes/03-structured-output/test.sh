#!/usr/bin/env bash
# Spike-03: compare structured output modes. Run each 3x to gauge consistency.
set -euo pipefail

BASE="${BASE:-http://localhost:8787}"
ATTEMPTS="${ATTEMPTS:-3}"

PASS=0
FAIL=0
A_OK=0
A_FAIL=0
B_OK=0
B_FAIL=0

assert_ok() {
  local label="$1" extract="$2"
  local err
  err=$(echo "$extract" | jq -r '.parse_error // empty')
  local violations
  violations=$(echo "$extract" | jq -r '.schema_violations | length')
  if [ -z "$err" ] && [ "$violations" = "0" ]; then
    echo "  [ok ] $label"
    PASS=$((PASS + 1))
    return 0
  else
    echo "  [!!] $label: parse_error='$err' violations=$violations"
    FAIL=$((FAIL + 1))
    return 1
  fi
}

echo "==================== MODE A: response_format ===================="
for i in $(seq 1 "$ATTEMPTS"); do
  echo "-- attempt $i"
  RES=$(curl -s -X POST "$BASE/test/a")
  EXTRACT=$(echo "$RES" | jq -c '.extract')
  echo "  raw_text snippet: $(echo "$RES" | jq -r '.extract.raw_text // "null"' | head -c 100)"
  USAGE=$(echo "$EXTRACT" | jq -r '.usage | "prompt=\(.prompt) completion=\(.completion) total=\(.total)"')
  echo "  usage: $USAGE"
  if assert_ok "Mode A attempt $i passes" "$EXTRACT"; then
    A_OK=$((A_OK + 1))
  else
    A_FAIL=$((A_FAIL + 1))
  fi
done

echo
echo "==================== MODE B: single-tool-submit ===================="
for i in $(seq 1 "$ATTEMPTS"); do
  echo "-- attempt $i"
  RES=$(curl -s -X POST "$BASE/test/b")
  EXTRACT=$(echo "$RES" | jq -c '.extract')
  TC=$(echo "$EXTRACT" | jq -r '.raw_tool_call.name // "null"')
  ARGS_SNIP=$(echo "$EXTRACT" | jq -r '.raw_tool_call.arguments_text // "null"' | head -c 100)
  USAGE=$(echo "$EXTRACT" | jq -r '.usage | "prompt=\(.prompt) completion=\(.completion) total=\(.total)"')
  echo "  tool_call: $TC, args snippet: $ARGS_SNIP"
  echo "  usage: $USAGE"
  if assert_ok "Mode B attempt $i passes" "$EXTRACT"; then
    B_OK=$((B_OK + 1))
  else
    B_FAIL=$((B_FAIL + 1))
  fi
done

echo
echo "============== RESULTS =============="
echo "Mode A (response_format): $A_OK ok, $A_FAIL fail out of $ATTEMPTS"
echo "Mode B (single-tool-submit): $B_OK ok, $B_FAIL fail out of $ATTEMPTS"

DECISION=""
if [ "$A_OK" = "$ATTEMPTS" ] && [ "$B_OK" = "$ATTEMPTS" ]; then
  DECISION="both work -> prefer Mode A (cleaner API surface)"
elif [ "$A_OK" = "$ATTEMPTS" ]; then
  DECISION="only Mode A works -> ship withStructuredOutput as response_format wrapper"
elif [ "$B_OK" = "$ATTEMPTS" ]; then
  DECISION="only Mode B works -> ship withStructuredOutput as single-tool-submit pattern"
elif [ "$A_OK" -gt 0 ] || [ "$B_OK" -gt 0 ]; then
  DECISION="partial reliability -> further investigation needed"
else
  DECISION="both modes broken on this model -> defer or pick different model"
fi
echo "Decision: $DECISION"
echo "====================================="

if [ "$A_OK" = "0" ] && [ "$B_OK" = "0" ]; then
  exit 1
fi
exit 0
