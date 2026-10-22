#!/usr/bin/env bash
# Read-only Android evidence collection. This never claims a delivery test passed.
set -euo pipefail
usage() {
  cat <<'USAGE'
Usage: bash scripts/capture-local-reminder-device.sh LABEL [OUTPUT_DIRECTORY]

Capture read-only Android state before/after a manual local-reminder scenario.
LABEL: letters, digits, dots, underscores or hyphens (for example before-reboot).
Default output: /tmp/habit-reminder-device-LABEL-UTC_TIMESTAMP
Set ANDROID_SERIAL when more than one adb device is attached.
Set REMINDER_ANDROID_PACKAGE only when testing a different application ID.

This script does not send notifications, change permission settings, kill the app,
reboot the device, or determine pass/fail. Follow docs/android-local-reminders-verification.md.
Review captured device/account identifiers before attaching evidence to a report.
USAGE
}
if [[ ${1:-} == --help || ${1:-} == -h ]]; then usage; exit 0; fi
if [[ $# -lt 1 || $# -gt 2 || ! $1 =~ ^[A-Za-z0-9._-]+$ ]]; then usage >&2; exit 2; fi
command -v adb >/dev/null || { echo 'adb is not installed; no device check ran.' >&2; exit 1; }
reminder_package=${REMINDER_ANDROID_PACKAGE:-com.haddadgavriel.habittracker}
if [[ ! $reminder_package =~ ^[A-Za-z0-9_.]+$ ]]; then echo 'Invalid application ID.' >&2; exit 2; fi
adb get-state >/dev/null
reminder_output=${2:-/tmp/habit-reminder-device-$1-$(date -u +%Y%m%dT%H%M%SZ)}
mkdir -p "$reminder_output"
{
  printf 'Scenario label: %s\nCaptured at UTC: %s\nApplication ID: %s\n' "$1" "$(date -u +%FT%TZ)" "$reminder_package"
  printf 'adb state: '; adb get-state
  printf 'Android SDK: '; adb shell getprop ro.build.version.sdk
  printf 'Android release: '; adb shell getprop ro.build.version.release
  printf 'Manufacturer: '; adb shell getprop ro.product.manufacturer
  printf 'Model: '; adb shell getprop ro.product.model
  printf 'Build fingerprint: '; adb shell getprop ro.build.fingerprint
  printf 'Device timezone: '; adb shell getprop persist.sys.timezone
  printf 'Boot count: '; adb shell settings get global boot_count
  printf 'Current app PID (empty is allowed): '; adb shell pidof "$reminder_package" || true
} > "$reminder_output/device.txt"
adb shell dumpsys package "$reminder_package" > "$reminder_output/package.txt"
adb shell cmd appops get "$reminder_package" > "$reminder_output/appops.txt" 2>&1 || true
# Keep only matching application/channel lines from global services. Do not ask
# NotificationManager for unredacted notification bodies or dump app-private files.
adb shell dumpsys alarm | awk -v app="$reminder_package" 'index($0, app)' > "$reminder_output/alarm-lines.txt"
adb shell dumpsys notification | awk -v app="$reminder_package" 'index($0, app) || index($0, "local-habit-reminders")' > "$reminder_output/notification-lines.txt"
{
  adb shell dumpsys deviceidle get deep || true
  adb shell dumpsys deviceidle get light || true
} > "$reminder_output/device-idle.txt" 2>&1
cat > "$reminder_output/observations.txt" <<'OBSERVATIONS'
Manual result: NOT RUN / PASS / FAIL / BLOCKED (choose after observing)
App commit/build:
Test account aliases (do not include credentials):
Profile timezone and server-local occurrence date:
Settings permission/local scheduling status before and after:
Configured future reminder times:
Expected and observed notification/tap times:
Network state / battery restrictions / exact-alarm access:
Scenario steps, restoration steps and discrepancies:

An alarm registration or appop listing is not proof of notification delivery.
A missing alarm dump line is not proof of a scheduling failure on every OEM/API.
OBSERVATIONS
printf 'Read-only evidence written to %s. Manual result remains NOT RUN until observed.\n' "$reminder_output"
