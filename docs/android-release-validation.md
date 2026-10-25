# Current release validation — 2026-10-25

**Release blocked.** Application regressions pass, but two Expo toolchain
advisories, operational deletion-maintenance activation, signing access and
physical-device acceptance remain unresolved. No deployment, Blueprint sync,
shared migration, live account deletion, email or push was performed.

These checks were recorded against the then-uncommitted working tree based on
`915333fb899a20e5a6ec01c23453ca4b037d13e6`; they do not certify a release. Source hashes,
artifact scope and blocker evidence are in
[`manifest.json`](release-evidence/2026-10-25/manifest.json). The recording time uses
`Asia/Jerusalem`; the native report retains its UTC test time.
[Earlier 2026-10-23 evidence](release-evidence/2026-10-23-validation.md)
is archived separately; its counts, missing-SDK statement and CI runs do not
describe this revision.

## Checks actually executed

| Check | Result and scope |
|---|---|
| npm lockfile install | PASS with npm 10.9.4, matching the Node 22 CI toolchain's npm generation; npm 11 lock compatibility also checked. The local decoder override is part of the lockfile. |
| Expo SDK dependency check | Offline check reports dependencies up to date, with its explicit warning that offline validation is less reliable. No online compatibility claim. |
| Mobile regressions | **731 passed, 0 failed/skipped**. Includes the real query-string dependency path and a malformed-URL subprocess deadline. |
| TypeScript | PASS, `tsc --noEmit`. |
| Backend and disposable PostgreSQL | **1,733 passed**, with PostgreSQL 16 and all **16 migrations** through `20261025113327_excuse_owner_identity.sql`. Includes new maintenance concurrency/deadline/failure tests and cross-runtime timezone tests. No live Auth transport. |
| Real local HTTP journey | PASS: FastAPI → PostgREST 12.2.12 → migrated PostgreSQL, with fixture Auth and a fake push recorder. Owner/social permissions, excuse decisions and reminder idempotency pass. The initial attempt exposed a PostgreSQL init-server readiness race; both local runners now wait for the final TCP listener. No live Auth/FCM or native UI claim. |
| Python requirements advisory scan | PASS: `pip-audit 2.10.1 -r backend/requirements-dev.txt`, zero known advisories. Includes production and test dependencies. |
| npm advisory scan | **BLOCKED: five high vulnerable packages from two underlying toolchain advisories**; no moderate/critical findings remain. Full output retained below. |
| Native reminder engine | **39 Android adapter tests passed, 0 failed/errors/skipped** in the current session, before the later JS/Python dependency-only edits. Production engine AAR contains the exact shared timezone catalog. This isolated AAR excludes the Expo bridge and is not an application APK or device test. |
| Android Hermes export after dependency changes | PASS, approximately 3.9 MB; bundle hash in the manifest. Uses loopback fixture URLs/public key. **Not a signed APK or a distributable build.** |
| Deletion-maintenance configuration | PASS for local YAML parsing, bounded command and cross-service env-key references. **Render platform validation BLOCKED**: docs/schema endpoints return HTTP 403; the connector has no selected workspace. No cron was created or enabled. |
| Existing EAS signing access | **BLOCKED**: `CI=1 npx eas-cli@25.3.0 whoami` exits 1, “Not logged in”. No Expo token, local credential file, real Firebase client configuration or release public environment is configured. No new signing identity was generated. |
| Signed application build | **NOT RUN: prerequisite signing/configuration check blocked.** No APK, EAS build ID, signing fingerprint or APK SHA-256 exists for this revision. |
| Device capture | **BLOCKED**: ADB lists no devices; the committed capture script exits with “error: no devices/emulators found”. No emulator or KVM device is available. |
| Maestro / physical two-device acceptance | **NOT RUN**. No screenshots, JUnit UI report, live Auth recovery/deletion, FCM receipt, alarm/reboot delivery, TalkBack or in-place signed-update result is claimed. |
| Whitespace/diff check | PASS, `git diff --check`. |

The dependency upgrades retain FastAPI's current httpx TestClient compatibility
path, which emits a deprecation warning. It did not fail the tests and is separate
from the advisory scan.

Direct records: [automated-check summaries](release-evidence/2026-10-25/automated-checks.txt),
[signing preflight](release-evidence/2026-10-25/signing-preflight.txt),
[device preflight](release-evidence/2026-10-25/device-preflight.txt), and
[native engine summary](release-evidence/2026-10-25/native-summary.json).

## Dependency remediation and remaining blockers

Before/after scanner outputs are stored alongside this report as machine-readable evidence:

- [npm before](release-evidence/2026-10-25/npm-audit-before.json) and
  [npm after](release-evidence/2026-10-25/npm-audit-after.json): 11 vulnerable
  packages → 5; all six moderate package findings removed.
- [Python before](release-evidence/2026-10-25/python-audit-before.json) and
  [Python after](release-evidence/2026-10-25/python-audit-after.json): 16 reported
  advisory records across Starlette and pytest → 0 (the original report repeats
  some advisory identifiers).

FastAPI is now 0.162.0, Starlette 1.10.0, pytest 9.1.1 and pytest-asyncio 1.4.0.
The mobile lockfile uses Expo 57.0.31, Router 57.0.29 and config-plugins 57.0.11.
The supported SDK 57 patch line is retained.

The runtime malformed-URL issue
[GHSA-vcc3-ghjq-m6fr](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr) is addressed
by a [licensed CommonJS backport](../mobile/vendor/decode-uri-component/README.md)
of upstream decode-uri-component 0.5.1. Its linear decoder is unchanged; only the
module export and legacy plus-sign behavior are adapted. A direct override to
upstream's ESM-only package would break query-string 7's callable CommonJS import.
Tests and the Android export exercise the installed backport.

The remaining high findings are:

| Root advisory | Current dependency and disposition |
|---|---|
| [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) | `node-forge@1.4.0`, reached through Expo CLI and code-signing-certificates. The registry's latest release is affected; no patched release was available in this check. No custom cryptographic patch was invented. |
| [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) | Expo CLI uses `zod@3.25.76`. The fixed 4.6.7 release crosses the CLI's major-version contract; latest CLI 58.1.15 also declares Zod 3. A compatible upstream update or separately validated backport is still required. |

The five vulnerable packages are `node-forge`, `zod`, `@expo/cli`,
`@expo/code-signing-certificates`, and `expo`. They are tooling dependency paths,
but remain a release blocker. The new Dependency advisories workflow intentionally
fails on this report; it contains no advisory allowlist. Do not use npm's proposed
Expo 44 downgrade or force incompatible major overrides to make the scanner green.

## Deletion maintenance and release handoff

The prepared cron runs every 15 minutes in UTC with automatic code deployments
off. It resumes only existing durable deletion requests, processes at most 100
with concurrency four, stops processing after 240 seconds, and reports only
aggregate counts. Pending work, timeout or errors produce a nonzero exit for
monitoring. [Operational ownership and activation checks](account-deletion.md)
are documented; no live sweep or alert delivery was verified.

Before distribution: resolve the two advisories, validate/deploy the maintenance
configuration in the intended workspace, verify a disposable staging recovery and
failure notification, then build with the existing signing key and real matching
EAS/Firebase/API configuration. Attach the signed APK's SHA-256, certificate,
versionCode, build ID and source revision. Install/update that exact APK on two
authorized Android devices and complete the [runbook](android-release-runbook.md).
These are remaining gates, not automatic deployment instructions for this session.
