# Android remote-push and EAS setup

This project uses package name **`com.habittracker.infrastructureproof`**. A development build is a custom debug app containing native notification code; unlike Expo Go, it is tied to this Firebase/EAS configuration and can receive remote pushes reliably.

## 1. Create and configure Firebase

1. Open [Firebase Console](https://console.firebase.google.com), select **Add project**, and finish the wizard (Analytics is optional).
2. On Project overview choose **Add app → Android**.
3. Enter Android package name `com.habittracker.infrastructureproof`. The nickname and SHA certificate are optional for push.
4. Choose **Register app**, then download **`google-services.json`**.
5. Put that file at `mobile/google-services.json`. It is ignored by Git. Never commit it.
6. In Firebase open **Project settings → Cloud Messaging**. Confirm that **Firebase Cloud Messaging API (V1)** is enabled. If prompted, use the link to Google Cloud Console to enable it.
7. Open **Project settings → Service accounts → Generate new private key**, confirm, and retain the downloaded JSON outside this repository. This credential is uploaded to EAS in the next section; it does not belong in the app or Render.

## 2. Create/link the Expo project and upload FCM credentials

Install Node.js 20 or later, then run:

```bash
npm install --global eas-cli
eas login
cd mobile
npm install
eas init
```

`eas init` creates/links an Expo project and prints its UUID. Replace `REPLACE_WITH_EAS_PROJECT_ID` in `mobile/app.json` with that UUID, and set the same value as `EXPO_PUBLIC_EAS_PROJECT_ID` in `mobile/.env`.

Upload the Firebase service-account JSON:

```bash
eas credentials --platform android
```

Choose **production** when asked for a build profile (credentials are shared by the profiles), then **Google Service Account → Manage your Google Service Account Key for Push Notifications (FCM V1) → Upload a new service account key**, and select the private-key JSON downloaded from Firebase. Menu wording can vary slightly by EAS CLI release; choose the FCM V1 push-notification service-account option, not a Play Store submission key.

## 3. Build and install an APK

For the simplest standalone test build:

```bash
cd mobile
cp .env.example .env              # then fill every value
npm install
eas build --platform android --profile preview
```

EAS prints a build URL and QR code. Open it on the physical Android phone, download the APK, allow installation from that browser when Android asks, and install it. Play Store publishing is not needed. Environment variables prefixed `EXPO_PUBLIC_` are compiled into the binary, so rebuild after changing them.

For live JavaScript development instead:

```bash
eas build --platform android --profile development
npx expo start --dev-client
```

Install the resulting development APK, keep the computer and phone able to reach Metro (use `npx expo start --dev-client --tunnel` if LAN discovery fails), and scan the terminal QR code from the development build.

## 4. Verify registration and the real push

1. Ensure the Render URL in `EXPO_PUBLIC_API_URL` is HTTPS and has no path suffix.
2. Launch the installed app, sign up/sign in, and tap **Register notifications**.
3. Allow Android's notification prompt. The screen must say the token was persisted.
4. In Supabase Table Editor inspect `device_push_tokens`; one row should contain the signed-in user's UUID and an `ExponentPushToken[...]`/`ExpoPushToken[...]` value. Do not expose or share that value.
5. Tap **Run Infrastructure Test** and copy the displayed request ID.
6. Confirm all API/database/push-request stages are checked and a notification with the same ID arrives. Background or fully close the app and repeat to prove this is remote delivery rather than an in-app local notification.
7. Inspect `infrastructure_tests` in Supabase. Its status should be `push_accepted`, and `expo_ticket_id` contains Expo's acceptance ticket.

An Expo ticket means Expo accepted the message, not that the phone displayed it. Device-level delivery can still fail because notification permission is disabled, FCM credentials are wrong, or battery/network restrictions intervene. The ticket ID is retained for diagnosis; this intentionally does not add a receipt-polling subsystem to the proof.
