#!/usr/bin/env bash
#
# End-to-end demo of the durable workflow engine.
#
#   ./scripts/demo.sh
#
# Starts the API on a throwaway SQLite database, runs the happy path, then runs
# a workflow whose shipping step fails permanently and watches the saga roll
# back the payment and inventory reservations.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-$(( (RANDOM % 10000) + 30000 ))}"
DATABASE_PATH="${DATABASE_PATH:-/tmp/durable-demo-$$.db}"
BASE="http://127.0.0.1:${PORT}"

if [[ ! -f dist/index.js ]]; then
  echo "Building..."
  npm run build >/dev/null
fi

NODE_BIN="$(node -p 'process.execPath')"

echo "Starting API on ${BASE} (database: ${DATABASE_PATH})"
DATABASE_PATH="$DATABASE_PATH" PORT="$PORT" LOG_LEVEL=warn "$NODE_BIN" dist/index.js &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  rm -f "${DATABASE_PATH}" "${DATABASE_PATH}-shm" "${DATABASE_PATH}-wal"
}
trap cleanup EXIT

for _ in $(seq 1 100); do
  if curl -sf "${BASE}/health" >/dev/null; then break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Server failed to start" >&2
    exit 1
  fi
  sleep 0.1
done

create_run() {
  curl -s -X POST "${BASE}/api/workflows/order-processing/runs" \
    -H 'content-type: application/json' \
    -d "$1" | python3 -c 'import sys,json; print(json.load(sys.stdin)["run"]["id"])'
}

wait_for_settlement() {
  local id="$1"
  for _ in $(seq 1 100); do
    local status
    status=$(curl -s "${BASE}/api/runs/${id}" | python3 -c 'import sys,json; print(json.load(sys.stdin)["run"]["status"])')
    case "$status" in
      completed|compensated|failed|cancelled) return 0 ;;
    esac
    sleep 0.1
  done
  return 1
}

show_run() {
  curl -s "${BASE}/api/runs/$1" | python3 -c '
import sys, json
d = json.load(sys.stdin)
run = d["run"]
print("  run status :", run["status"])
print("  steps      :", [s["status"] for s in d["steps"]])
print("  output     :", run["output"])
print("  error      :", run["error"])
'
}

echo
echo "1) Happy path"
ID=$(create_run '{"input":{"orderId":"demo-1","customerId":"c-1","items":[{"sku":"sku-1","quantity":2}],"amount":49.5}}')
wait_for_settlement "$ID"
show_run "$ID"

echo
echo "2) Permanent failure in arrange-shipping -> compensate payment + inventory"
COMPENSATED_ID=$(create_run '{"input":{"orderId":"demo-2","customerId":"c-1","items":[{"sku":"sku-1","quantity":1}],"amount":10,"faults":{"arrange-shipping":{"permanent":true}}}}')
wait_for_settlement "$COMPENSATED_ID"
show_run "$COMPENSATED_ID"

echo
echo "3) Transient failure in process-payment -> retried, then completes"
ID=$(create_run '{"input":{"orderId":"demo-3","customerId":"c-1","items":[{"sku":"sku-1","quantity":1}],"amount":25,"faults":{"process-payment":{"failTimes":1}}}}')
wait_for_settlement "$ID"
show_run "$ID"

echo
echo "Event log for the compensated run:"
curl -s "${BASE}/api/runs/${COMPENSATED_ID}/events" | python3 -c '
import sys, json
for event in json.load(sys.stdin)["events"]:
    print("  -", event["type"])
'
