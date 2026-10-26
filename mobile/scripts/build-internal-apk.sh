#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Reads only preview values, never production; file secrets are checked on EAS.
npx --yes eas-cli@26.0.0 whoami >&2
npx --yes eas-cli@26.0.0 env:exec preview 'node scripts/internal-apk-preflight.cjs --configuration-only' --non-interactive >&2
# No credential generation/rotation and no store submission.
exec npx --yes eas-cli@26.0.0 build --platform android --profile internal-testing \
  --non-interactive --freeze-credentials --wait --json
