# PR #33 internal-testing APK preparation

Source base: `f5df2a7e371a7246d87e8a9a25b8633885d57c5a` from PR #33.
Preparation branch: `codex/internal-testing-preparation`.

**No APK or EAS build URL has been produced yet.** This preparation is for the
user-authorized internal test, with physical-device acceptance after installation.
It does not certify production readiness or clear the dependency advisories.
The production branch, Render service, Supabase database, signing credentials and
dependency-audit workflow have not been changed.

## Confirmed access blockers

- EAS CLI 26.0.0 `whoami` returns **Not logged in**. The runtime has no `EXPO_TOKEN`.
  Configure it through secure workspace settings for an account authorized on EAS
  project `4f31560d-6323-41f7-ae0a-f792a4814c98`; never paste it into chat or Git.
- The execution environment's HTTPS proxy rejects `https://api.expo.dev/graphql`
  with CONNECT **403 Forbidden**. Its supported network settings must permit
  `api.expo.dev` and any EAS upload/download hosts required by the actual build.
  Authentication alone will not fix this network restriction.
- Local `google-services.json`, signing keystore/credentials.json and Android SDK
  are absent. Existing remote signing credentials, Firebase file variables and
  versionCode are **unverified behind EAS authentication**, not assumed missing
  from the account. Do not generate replacements or run `eas init`.
- Render has no selected workspace. The available workspace is `My Workspace`
  (`tea-dak30qgjo6nc73bab7fg`); its connector requires user selection before access.
- Supabase lists the existing HabbitTracker project `zsqzenswefkjaundwyct` in
  organization `celfocnmmhpsdbpgofxx`, with **no development branches**. A new
  isolated branch requires the selected organization and the platform's cost
  confirmation. The backend then needs that branch's own server secret. The
  connected publishable-key tool does not expose a server secret.

## Prepared build path

`mobile/eas.json` adds `internal-testing`, extending the existing preview profile:
APK, internal distribution, remote credentials, existing EAS ID, and increasing
remote Android versionCode. Existing profiles and the SDK/lockfile are unchanged.

The post-install check runs only for this internal profile. It rejects the
production Supabase ref, mismatched/mobile-secret configuration, unexpected API
origins, replacement EAS IDs, and Firebase files with the wrong existing project
or Android package. The build wrapper uses `--freeze-credentials` and never
auto-submits to a store. The Android package remains
`com.haddadgavriel.habittracker`; the scheme remains `habittrackerinfra`.

## Isolated backend setup

1. Select the intended Render workspace and Supabase organization. Obtain the
   branch cost through Supabase and confirm it before creation. Create a fresh
   development branch, without copying production data. Record its new ref.
2. Inspect the branch's migration history. Apply only missing, reviewed migrations
   in order, through `20261026063642_fair_deletion_maintenance.sql` (17 total).
   All changes must use the **new branch ref**, never `zsqzenswefkjaundwyct`.
3. Supply the new branch URL, publishable key and server secret to a **new** Render
   service named `habit-tracker-pr33-internal`. The separate
   `render.internal-testing.yaml` defines the source branch, disabled auto-deploy,
   and startup guard. It contains no production references or inherited secrets.
   Do not sync the existing production `render.yaml`. The proposed free service
   can sleep between requests; a first request may require a cold start.
4. Validate the Blueprint with `render blueprints validate render.internal-testing.yaml`
   using authenticated Render access. YAML/isolation checks passed locally;
   platform validation is pending. The workspace cannot fetch Render's schema
   endpoint (HTTP 403). The current Blueprint field documentation was checked.
5. Deploy that preparation branch and record the deployed commit. Check `/health`
   and authenticated profile, Today and reminder-plan reads using disposable
   accounts. `/health` alone does not prove database/Auth compatibility. Match
   the backend source commit to the mobile build source. Never deploy the
   loopback fixture entry point as the hosted backend.
6. Configure Auth callback allowlists on the **isolated branch** for the existing
   `habittrackerinfra://auth-callback` scheme. The Supabase connector does not
   provide an Auth-settings write tool; use that branch's Dashboard if needed.
   Use disposable test accounts; real email/FCM acceptance follows installation.

## Existing EAS/Firebase/signing configuration

Read the existing EAS project's preview variables and Android credentials after
authentication. Reuse the existing keystore and record its certificate SHA-256.
Verify the Firebase Android client belongs to the existing Firebase project and
package. Reuse the existing FCM credential; do not generate a new signing key or
Firebase/EAS project. No FCM send is necessary to create the APK.

Configure the values listed in `mobile/internal-testing.env.example` in the
**preview** EAS environment, with the actual isolated backend URL/ref/key.
`INTERNAL_TESTING_API_ORIGIN` must exactly match `EXPO_PUBLIC_API_URL`.
`INTERNAL_TESTING_FIREBASE_PROJECT_ID` is the existing Firebase project ID.
`GOOGLE_SERVICES_JSON` must be the existing Android client file as an EAS file
variable. Never place the backend server secret in any mobile/EAS public variable.
Production EAS environment variables are not modified.

From a full repository checkout on the preparation branch (the native module also
packages the shared catalog from `backend/app/data`):

```bash
cd mobile
npm ci
npm test
npm run typecheck
bash scripts/build-internal-apk.sh > ../internal-build-result.json
```

The wrapper reads preview configuration, checks it, then runs:

```bash
npx --yes eas-cli@26.0.0 build --platform android --profile internal-testing \
  --non-interactive --freeze-credentials --wait --json
```

If existing credentials cannot be used, stop and restore access to them. Do not
retry with credential generation, `--without-credentials`, debug signing, or a
different application ID. A successful result must provide the actual EAS build
ID and APK download URL; do not substitute a project dashboard link for a build.
After success, use `eas build:view BUILD_ID --json`, download the APK, and record
its SHA-256, source commit, package/versionCode and certificate fingerprint.
Compare the certificate to the existing app before handing it off.

## Installation, once the signed APK exists

Use a dedicated test device or Android user profile. Preserving the existing
package and certificate means this APK replaces that app in the selected Android
profile; it is not a second side-by-side package. Main and the hosted production
services remain unchanged.

Open the **actual EAS build download URL** on the phone, download the APK, and
allow installation from that browser when Android prompts. Alternatively:

```bash
adb install -r habit-tracker-internal.apk
```

Do not uninstall or use signature/version bypasses to work around a mismatch.
Start with the isolated test accounts. Physical-device acceptance, live email/
FCM, alarm/reboot behavior and accessibility checks come **after installation**.
The existing node-forge/Zod advisory gate stays red; this authorized internal test
does not authorize main merge, production deployment, or public distribution.
