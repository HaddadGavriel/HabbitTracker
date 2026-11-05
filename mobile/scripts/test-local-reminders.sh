#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
build_dir=$(mktemp -d)
trap 'rm -rf "$build_dir"' EXIT
source_dir=modules/local-reminders/android/src
cp ../backend/app/data/timezones-v1.txt "$build_dir/"
javac -d "$build_dir" "$source_dir/main/java/com/habbittracker/reminders/TimezonePolicy.java" "$source_dir/main/java/com/habbittracker/reminders/Planner.java" "$source_dir/main/java/com/habbittracker/reminders/Journal.java" "$source_dir/test/java/com/habbittracker/reminders/EngineTest.java"
java -cp "$build_dir" com.habbittracker.reminders.EngineTest
