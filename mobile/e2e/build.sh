#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# The same native code/app ID, with loopback services; never distribute this APK.
export EXPO_NO_DOTENV=1 EXPO_PUBLIC_API_URL=http://127.0.0.1:18000/api
export EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:18000 EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_smoke_only
export EXPO_PUBLIC_ENABLE_DIAGNOSTICS=false
export RUNNER_TEMP=${RUNNER_TEMP:-/tmp}
node scripts/native-test-config.cjs
export GOOGLE_SERVICES_JSON="$RUNNER_TEMP/reminder-google-services.json"
npx expo prebuild --platform android --no-install
# Allow only the loopback fixture host in this generated, untracked smoke build.
python3 - <<'PY'
from pathlib import Path
import re
p=Path('android/app/src/main/AndroidManifest.xml')
s=re.sub(r' android:networkSecurityConfig="[^"]*"', '', p.read_text()).replace('<application ', '<application android:networkSecurityConfig="@xml/smoke_network" ', 1)
p.write_text(s)
p=Path('android/app/src/main/res/xml/smoke_network.xml'); p.parent.mkdir(exist_ok=True)
p.write_text('<network-security-config><base-config cleartextTrafficPermitted="false"/><domain-config cleartextTrafficPermitted="true"><domain>127.0.0.1</domain></domain-config></network-security-config>')
PY
cd android
./gradlew :app:assembleRelease --no-daemon --max-workers=2
