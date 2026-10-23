#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Never clear data on a user's physical installation.
[ "$(adb shell getprop ro.kernel.qemu | tr -d '\r')" = 1 ] || { echo 'Use a dedicated Android emulator.' >&2; exit 1; }
python3 - <<'PY'
import json, urllib.request
with urllib.request.urlopen('http://127.0.0.1:18000/smoke-ready') as r:
    data=json.load(r)
assert data['environment']=='disposable-local-only' and data['real_pushes'] is False
PY
adb reverse tcp:18000 tcp:18000
adb install -r android/app/build/outputs/apk/release/app-release.apk
export MAESTRO_CLI_NO_ANALYTICS=1 MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
mkdir -p e2e/artifacts
# Ordered runs: social reuses the accounts created by owner, never parallelize.
maestro test --format junit --output e2e/artifacts/owner.xml e2e/flows/owner.yaml
maestro test --format junit --output e2e/artifacts/social.xml e2e/flows/social.yaml
