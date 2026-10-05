# Android remote-push and EAS setup

The fixed Android application/package identifier is **`com.haddadgavriel.habittracker`**. Create Firebase with that exact value; Android identifiers cannot be casually changed after Firebase and signed builds exist.

This app targets **Expo SDK 57**. A development build is a custom debug app containing native notification code. The preview profile produces a directly installable APK. Neither workflow relies on Expo Go.

## 1. Create Firebase configuration

1. Open [Firebase Console](https://console.firebase.google.com), choose **Add project**, and complete the wizard. Analytics is optional.
2. On **Project overview**, choose **Add app → Android**.
3. Enter Android package name `com.haddadgavriel.habittracker`; nickname and SHA certificate are optional for this push proof.
4. Choose **Register app**, download `google-services.json`, and save it as `mobile/google-services.json` locally. It is deliberately ignored by Git.
5. Open **Project settings → Cloud Messaging** and ensure **Firebase Cloud Messaging API (V1)** is enabled. Follow its Google Cloud Console link if Firebase asks you to enable it.
6. Open **Project settings → Service accounts → Generate new private key**. Keep that service-account JSON outside the repository. This separate file is uploaded through EAS's Android credentials menu for FCM V1.

## 2. Install tools, align SDK dependencies, and link EAS

Install Node.js 20 or later, then run:

```bash
npm install --global eas-cli
eas login
cd mobile
npm install
npx expo install --fix
npx expo-doctor
eas init
```

`npx expo install --fix` is Expo's dependency-alignment tool; it should report the committed React, React Native, Router, and Expo modules as compatible with SDK 57. During `eas init`, create or select the Expo project. Copy the project UUID it reports (also visible under **expo.dev → project → Project settings → Project ID**).

The dynamic `mobile/app.config.ts` reads that UUID from `EXPO_PUBLIC_EAS_PROJECT_ID`. For subsequent local EAS commands in this shell, set it once:

```bash
export EXPO_PUBLIC_EAS_PROJECT_ID=YOUR_EAS_PROJECT_UUID
```

## 3. Configure the EAS preview environment

A gitignored `.env` and `google-services.json` are **not uploaded automatically** to a cloud builder. The `preview` profile in `eas.json` explicitly selects EAS's `preview` environment. From `mobile/`, create all four client-safe string variables there:

```bash
eas env:set --name EXPO_PUBLIC_SUPABASE_URL --value https://YOUR_PROJECT.supabase.co --environment preview --visibility plaintext
eas env:set --name EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY --value sb_publishable_YOUR_KEY --environment preview --visibility plaintext
eas env:set --name EXPO_PUBLIC_API_URL --value https://YOUR_RENDER_SERVICE.onrender.com --environment preview --visibility plaintext
eas env:set --name EXPO_PUBLIC_EAS_PROJECT_ID --value YOUR_EAS_PROJECT_UUID --environment preview --visibility plaintext
```

Upload the ignored Firebase config as a supported EAS **file** variable:

```bash
eas env:set --name GOOGLE_SERVICES_JSON --value ./google-services.json --type file --environment preview --visibility secret
eas env:list --environment preview
```

On the remote builder, EAS materializes that file and sets `GOOGLE_SERVICES_JSON` to its temporary path. `app.config.ts` passes that path to `android.googleServicesFile`. The local fallback remains `./google-services.json`.

The variables with `EXPO_PUBLIC_` are intentionally public and embedded in the APK. Only use the Supabase publishable key here—never `SUPABASE_SECRET_KEY`, database passwords, or the Firebase service-account private key.

## 4. Upload the FCM V1 service-account credential

Run:

```bash
eas credentials --platform android
```

Select the project/build credentials, then **Google Service Account → Manage your Google Service Account Key for Push Notifications (FCM V1) → Upload a new service account key** and select the private-key JSON from Firebase step 1. CLI wording can vary slightly; choose the FCM V1 **push notification** key, not a Play Store submission key. This credential lets Expo deliver through FCM and is distinct from `google-services.json`.

## 5. Build and install the APK

Create the standalone preview build:

```bash
cd mobile
export EXPO_PUBLIC_EAS_PROJECT_ID=YOUR_EAS_PROJECT_UUID
eas build --platform android --profile preview
```

EAS reads the `preview` environment named in `eas.json`; no local `.env` is required for the remote job. Open the resulting URL or QR code on the physical Android phone, download the APK, allow installation from that browser when Android prompts, and install it. Google Play publication is not involved.

For live JavaScript development, repeat the environment-variable setup for `development` (replace `--environment preview` with `--environment development` in every command), then run:

```bash
eas build --platform android --profile development
npx expo start --dev-client
```

Install the development APK. Keep phone and computer able to reach Metro, or use `npx expo start --dev-client --tunnel` if LAN discovery fails.

## 6. Verify registration and real remote delivery

1. Confirm `EXPO_PUBLIC_API_URL` is your deployed HTTPS Render origin with no path suffix.
2. Launch the installed app, sign up/sign in, and tap **Register notifications**.
3. Allow Android's notification prompt. The screen must report that FastAPI persisted the token.
4. In Supabase Table Editor inspect `device_push_tokens`; a row should contain this user's UUID and an `ExponentPushToken[...]` or `ExpoPushToken[...]`. Do not share that token.
5. Tap **Run Infrastructure Test** and note the displayed request ID.
6. Confirm the API/database/push-request stages succeed and a notification carrying the identical ID arrives.
7. Inspect `infrastructure_tests`: status should be `push_accepted`, with an `expo_ticket_id`.
8. Repeat and immediately background or close the app. The Android OS must still display the notification, proving this is remote delivery rather than a local notification call.

An Expo ticket proves Expo accepted the request, not that Android displayed it. If delivery fails, verify notification permission, FCM V1 credentials, Firebase project/package consistency, connectivity, and battery restrictions. Receipt polling is intentionally outside this minimal proof.
