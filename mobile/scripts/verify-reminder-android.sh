#!/usr/bin/env bash
# Compile the unchanged production Android engine without React Native/Expo AARs.
set -euo pipefail
mobile_root=$(cd "$(dirname "$0")/.." && pwd)
verification_dir=${REMINDER_NATIVE_WORK_DIR:-$(mktemp -d)}
source_dir="$mobile_root/modules/local-reminders/android/src"
mkdir -p "$verification_dir/src/main/java/com/habbittracker/reminders" "$verification_dir/src/test/java/com/habbittracker/reminders"
for source in TimezonePolicy.java Planner.java Journal.java Engine.kt; do
  cp "$source_dir/main/java/com/habbittracker/reminders/$source" "$verification_dir/src/main/java/com/habbittracker/reminders/"
done
mkdir -p "$verification_dir/src/main/resources"
cp "$mobile_root/../backend/app/data/timezones-v1.txt" "$verification_dir/src/main/resources/"
cp "$source_dir/test/java/com/habbittracker/reminders/AndroidAdapterTest.kt" "$verification_dir/src/test/java/com/habbittracker/reminders/"
cp "$source_dir/main/AndroidManifest.xml" "$verification_dir/src/main/AndroidManifest.xml"
cat > "$verification_dir/settings.gradle" <<'GRADLE'
rootProject.name = 'reminder-android-engine-verification'
GRADLE
cat > "$verification_dir/build.gradle" <<'GRADLE'
buildscript {
  repositories { google(); mavenCentral() }
  dependencies {
    classpath 'com.android.tools.build:gradle:8.12.0'
    classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:2.1.20'
  }
}
apply plugin: 'com.android.library'
apply plugin: 'org.jetbrains.kotlin.android'
repositories { google(); mavenCentral() }
android {
  namespace 'com.habbittracker.reminders'
  compileSdk 36
  defaultConfig { minSdk 24 }
  compileOptions {
    coreLibraryDesugaringEnabled true
    sourceCompatibility JavaVersion.VERSION_17
    targetCompatibility JavaVersion.VERSION_17
  }
  kotlinOptions { jvmTarget = '17' }
  testOptions { unitTests.includeAndroidResources = true }
}
dependencies {
  implementation 'androidx.core:core-ktx:1.17.0'
  implementation 'androidx.work:work-runtime-ktx:2.11.1'
  coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:2.1.5'
  testImplementation 'junit:junit:4.13.2'
  testImplementation 'org.robolectric:robolectric:4.16.1'
  testImplementation 'androidx.work:work-testing:2.11.1'
}
GRADLE
printf 'android.useAndroidX=true\n' > "$verification_dir/gradle.properties"
"${GRADLE_EXECUTABLE:-$mobile_root/android/gradlew}" --project-dir "$verification_dir" testDebugUnitTest assembleDebug --no-daemon --max-workers=2 -Dorg.gradle.jvmargs=-Xmx2g
