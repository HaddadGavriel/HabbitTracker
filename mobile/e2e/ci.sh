#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p mobile/e2e/artifacts
python mobile/e2e/stack.py > mobile/e2e/artifacts/stack.log 2>&1 &
stack_pid=$!
trap 'kill "$stack_pid" 2>/dev/null || true; wait "$stack_pid" 2>/dev/null || true' EXIT
for attempt in {1..60}; do
  if curl -fsS http://127.0.0.1:18000/smoke-ready >/dev/null; then break; fi
  kill -0 "$stack_pid"
  sleep 1
done
bash mobile/e2e/run.sh
