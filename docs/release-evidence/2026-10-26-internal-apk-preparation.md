# Internal APK preparation — 2026-10-26

Base: PR #33 head `f5df2a7e371a7246d87e8a9a25b8633885d57c5a`.
The separate `codex/internal-testing-preparation` branch prepares an installable
internal APK and matching isolated backend without changing main or production.
No hosted test backend or EAS build has been created: required account selection,
Expo authentication and network access are pending.

## Completed preparation and checks

- Added an `internal-testing` EAS profile, retaining SDK 57, the package/lockfile
  dependency versions, EAS project, remote credentials and increasing versionCode.
- Added a frozen-credentials build wrapper and profile-only post-install guard.
- Added a separate test API Blueprint and isolated-project startup guard. The
  production `render.yaml`, backend `app` code and EAS production profile are unchanged.
- **747 mobile tests passed**, zero failures/skips, including 11 new guard tests.
- TypeScript passed; resolved Expo configuration still has Android package
  `com.haddadgavriel.habittracker` and EAS project
  `4f31560d-6323-41f7-ae0a-f792a4814c98`.
- EAS CLI **26.0.0** schema/profile resolution passed: Android APK, internal
  distribution, remote credentials, preview environment and auto-increment.
- The real post-install hook passed with an explicitly synthetic Firebase client
  file and isolated configuration. This verifies wiring, not real Firebase access.
- Backend guard accepted the matching isolated fixture and rejected five unsafe
  configurations. Shell syntax, YAML syntax/isolation invariants and whitespace passed.
- The SDK lockfile, production configuration, backend application code and
  dependency-audit workflow match the PR #33 base byte-for-byte. Existing npm
  advisory failures remain documented; the gate was not suppressed.

## Observed blockers, not inferred missing credentials

- EAS `whoami`: **Not logged in**. Runtime secret/variable readiness lists are empty.
- `https://api.expo.dev/graphql`: proxy CONNECT denied with **403 Forbidden**.
  `api.expo.dev` is absent from the enforced HTTP policy's allowed hosts.
- No local Firebase client file, signing keystore/credentials.json or Android SDK.
  Remote EAS credentials/Firebase file/versionCode cannot be verified until login.
- Render connector: **no workspace selected**, requires user selection. Available
  workspace: `tea-dak30qgjo6nc73bab7fg` (My Workspace).
- Supabase: existing `zsqzenswefkjaundwyct` is healthy; **no test branches**. User
  organization selection and platform branch-cost confirmation are pending.
- Backend server secret for an isolated project is unavailable; the connected
  publishable-key tool does not return server secrets. No production key was read
  or copied. Existing Auth-setting write capability is also absent from the plugin.
- Render platform Blueprint validation remains unrun. Fetching its JSON schema
  endpoint from this workspace returned HTTP 403; current field documentation was
  read through the connected web tool. Local YAML checks do not replace validation.

No APK/build ID/download URL/certificate fingerprint is claimed. Physical-device
acceptance follows installation, as requested. No production service, database,
Auth setting, deployment, signing key or main branch was changed.

[Access requirements, exact build command and installation steps](../internal-testing-apk.md).
