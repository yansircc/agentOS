#!/usr/bin/env bash
# Spike-04: discover stable structured-submit model/strategy tuples.
set -euo pipefail

BASE="${BASE:-http://localhost:8787}"
ATTEMPTS="${ATTEMPTS:-3}"
FALLBACK_ATTEMPTS="${FALLBACK_ATTEMPTS:-0}"
SLEEP_SECONDS="${SLEEP_SECONDS:-0}"
CONCURRENCY="${CONCURRENCY:-8}"
CURL_MAX_TIME="${CURL_MAX_TIME:-90}"
MODEL_GROUP="${MODEL_GROUP:-active}"
PROMPT="${PROMPT:-Create two image prompts for an agentOS product launch visual. Use square 1024 by 1024 outputs.}"

DEFAULT_STRATEGIES=(
  "json-schema"
  "openai-forced"
)

MODELS_JSON="$(curl -fsS "$BASE/models")"

models_for_group() {
  case "$MODEL_GROUP" in
    active)
      echo "$MODELS_JSON" | jq -r '.catalogTextModels | join(",")'
      ;;
    catalog-text)
      echo "$MODELS_JSON" | jq -r '.catalogTextModels | join(",")'
      ;;
    official-json-mode)
      echo "$MODELS_JSON" | jq -r '.officialJsonModeModels | join(",")'
      ;;
    function-calling)
      echo "$MODELS_JSON" | jq -r '.functionCallingModels | join(",")'
      ;;
    all)
      echo "$MODELS_JSON" | jq -r '.catalogTextModels | join(",")'
      ;;
    *)
      echo "unknown MODEL_GROUP: $MODEL_GROUP" >&2
      exit 2
      ;;
  esac
}

IFS=',' read -r -a MODELS <<< "${MODELS:-$(models_for_group)}"
IFS=',' read -r -a STRATEGIES <<< "${STRATEGIES:-$(IFS=,; echo "${DEFAULT_STRATEGIES[*]}")}"

PASS=0
FAIL=0
RESULTS_FILE="${RESULTS_FILE:-/tmp/agent-os-spike04-results.jsonl}"
: > "$RESULTS_FILE"

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

post_plan() {
  local model="$1"
  local strategy="$2"
  local fallback="$3"
  jq -n \
    --arg model "$model" \
    --arg strategy "$strategy" \
    --arg prompt "$PROMPT" \
    --argjson allowContentFallback "$fallback" \
    '{model:$model, strategy:$strategy, prompt:$prompt, allowContentFallback:$allowContentFallback}' |
    curl -s --max-time "$CURL_MAX_TIME" -X POST "$BASE/plan" \
      -H 'content-type: application/json' \
      --data-binary @-
}

expected_source_for_strategy() {
  case "$1" in
    json-schema)
      echo "json_response"
      ;;
    openai-forced | cf-native-prompted)
      echo "tool_call"
      ;;
    *)
      echo "unknown"
      ;;
  esac
}

is_valid_plan_result() {
  local response="$1"
  local required_source="$2"
  local ok source tool image_count bad_prompts bad_dims
  ok=$(echo "$response" | jq -r '.ok')
  source=$(echo "$response" | jq -r '.source // ""')
  tool=$(echo "$response" | jq -r '.toolName // ""')
  image_count=$(echo "$response" | jq -r '(.output.images | length) // 0')
  bad_prompts=$(echo "$response" | jq -r '[.output.images[]? | select((.prompt | type) != "string")] | length')
  bad_dims=$(echo "$response" | jq -r '[.output.images[]? | select((.width | type) != "number" or (.height | type) != "number")] | length')

  [ "$ok" = "true" ] || return 1
  [ "$source" = "$required_source" ] || return 1
  if [ "$required_source" = "tool_call" ]; then
    [ "$tool" = "submit_image_plan" ] || return 1
  fi
  [ "$image_count" -ge 1 ] &&
    [ "$bad_prompts" = "0" ] &&
    [ "$bad_dims" = "0" ]
}

write_attempt_result() {
  local output_file="$1"
  local model="$2"
  local strategy="$3"
  local mode="$4"
  local attempt="$5"
  local response="$6"

  if echo "$response" | jq -c \
    --arg model "$model" \
    --arg strategy "$strategy" \
    --arg mode "$mode" \
    --argjson attempt "$attempt" \
    '{
      model: $model,
      strategy: $strategy,
      mode: $mode,
      attempt: $attempt,
      ok,
      source: (.source // null),
      schemaId: (.schemaId // null),
      toolName: (.toolName // null),
      error: (.error // null),
      reason: (.detail.reason // null),
      detail: (.detail // null),
      usage: (.usage // null),
      imageCount: (.output.images | length? // 0)
    }' > "$output_file"; then
    return 0
  fi

  jq -nc \
    --arg model "$model" \
    --arg strategy "$strategy" \
    --arg mode "$mode" \
    --argjson attempt "$attempt" \
    --arg response "$response" \
    '{
      model: $model,
      strategy: $strategy,
      mode: $mode,
      attempt: $attempt,
      ok: false,
      source: null,
      schemaId: null,
      toolName: null,
      error: "InvalidWorkerResponse",
      reason: null,
      detail: {response: $response},
      usage: null,
      imageCount: 0
    }' > "$output_file"
}

summarize_row() {
  local model="$1"
  local strategy="$2"
  local mode="$3"
  local required="$4"
  jq -rs \
    --arg model "$model" \
    --arg strategy "$strategy" \
    --arg mode "$mode" \
    --arg required "$required" \
    --argjson attempts "$ATTEMPTS" '
      map(select(.model == $model and .strategy == $strategy and .mode == $mode)) as $rows
      | ($rows | map(select(
          .ok == true
          and .source == $required
          and (.schemaId == "ImgGenPlan.v1")
          and (if $required == "tool_call" then .toolName == "submit_image_plan" else true end)
          and .imageCount >= 1
        )) | length) as $ok
      | ($rows | map(select(.error != null) | (.error + (if .reason then ":" + .reason else "" end))) | group_by(.) | map({key: .[0], count: length})) as $errors
      | {
          model: $model,
          strategy: $strategy,
          mode: $mode,
          ok: $ok,
          attempts: $attempts,
          verdict: (if $ok == $attempts then "PROMOTE_CANDIDATE" else "REJECT" end),
          errors: $errors
        }
    ' "$RESULTS_FILE"
}

echo "==================== candidate models ===================="
echo "$MODELS_JSON" | jq '{defaultModel, defaultStrategy, strategies, candidates, excludedVisionTextModels}'
echo "model group: $MODEL_GROUP"
echo "concurrency: $CONCURRENCY"

echo
echo "==================== strict matrix ===================="
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/agent-os-spike04.XXXXXX")
trap 'rm -rf "$WORK_DIR"' EXIT
JOB_INDEX=0

active_jobs() {
  jobs -rp | wc -l | tr -d ' '
}

wait_for_slot() {
  while [ "$(active_jobs)" -ge "$CONCURRENCY" ]; do
    sleep 0.2
  done
}

run_attempt_job() {
  local job_index="$1"
  local model="$2"
  local strategy="$3"
  local mode="$4"
  local attempt="$5"
  local fallback="$6"
  local output_file="$WORK_DIR/$(printf '%05d' "$job_index").json"
  local response summary

  response=$(post_plan "$model" "$strategy" "$fallback" || true)
  write_attempt_result "$output_file" "$model" "$strategy" "$mode" "$attempt" "$response"
  summary=$(cat "$output_file" | jq -c '{ok, error, reason, model, strategy, schemaId, source, toolName, imageCount}')
  echo "[$mode] $model $strategy #$attempt $summary"
}

for model in "${MODELS[@]}"; do
  for strategy in "${STRATEGIES[@]}"; do
    for i in $(seq 1 "$ATTEMPTS"); do
      wait_for_slot
      JOB_INDEX=$((JOB_INDEX + 1))
      run_attempt_job "$JOB_INDEX" "$model" "$strategy" "strict" "$i" "false" &
      if [ "$SLEEP_SECONDS" != "0" ]; then
        sleep "$SLEEP_SECONDS"
      fi
    done
  done
done

if [ "$FALLBACK_ATTEMPTS" -gt 0 ]; then
  echo "==================== content fallback probe ===================="
  for model in "${MODELS[@]}"; do
    for strategy in "${STRATEGIES[@]}"; do
      for i in $(seq 1 "$FALLBACK_ATTEMPTS"); do
        wait_for_slot
        JOB_INDEX=$((JOB_INDEX + 1))
        run_attempt_job "$JOB_INDEX" "$model" "$strategy" "fallback" "$i" "true" &
        if [ "$SLEEP_SECONDS" != "0" ]; then
          sleep "$SLEEP_SECONDS"
        fi
      done
    done
  done
fi

wait
find "$WORK_DIR" -name '*.json' -print | sort | while IFS= read -r file; do
  cat "$file"
done > "$RESULTS_FILE"

echo "==================== strict summary ===================="
printf "%-54s %-18s %-8s %-18s %s\n" "model" "strategy" "strict" "verdict" "errors"
for model in "${MODELS[@]}"; do
  for strategy in "${STRATEGIES[@]}"; do
    required_source=$(expected_source_for_strategy "$strategy")
    summary=$(summarize_row "$model" "$strategy" "strict" "$required_source")
    ok=$(echo "$summary" | jq -r .ok)
    attempts=$(echo "$summary" | jq -r .attempts)
    verdict=$(echo "$summary" | jq -r .verdict)
    errors=$(echo "$summary" | jq -c .errors)
    printf "%-54s %-18s %-8s %-18s %s\n" "$model" "$strategy" "$ok/$attempts" "$verdict" "$errors"
  done
done

echo
echo "==================== unsupported boundary ===================="
unsupported_status=$(curl -s -o /tmp/agent-os-spike04-unsupported.json -w '%{http_code}' \
  -X POST "$BASE/plan" \
  -H 'content-type: application/json' \
  -d '{"model":"@cf/not-a-real/model","strategy":"openai-forced"}')
cat /tmp/agent-os-spike04-unsupported.json | jq '{ok, error, detail}'
unsupported_error=$(jq -r '.error // ""' /tmp/agent-os-spike04-unsupported.json)

echo
echo "============== ASSERTIONS =============="
assert_eq "unsupported model status" "400" "$unsupported_status"
assert_eq "unsupported model error" "UnsupportedStructuredOutputModel" "$unsupported_error"

echo "results jsonl: $RESULTS_FILE"
echo "PASS: $PASS    FAIL: $FAIL"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
