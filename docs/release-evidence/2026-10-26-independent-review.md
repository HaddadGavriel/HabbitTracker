# Independent review of PR #34 and dependency blockers — 2026-10-26

PR #34 was independently compared with PR #33: base
`1853140e9a04db22ee164a21246d9b5428c2f567`, head
`292a8a66ea4a4ba8b31f485af410b55d7279ff0e`. No blocking defect was found
in the 29-file follow-up. The application changes are suitable for integration
into `codex/release-hardening-and-evidence`. **Release remains blocked.**

[PR #34](https://github.com/HaddadGavriel/HabbitTracker/pull/34) was merged into
PR #33’s branch as `29c6874d8d10cd0757675edb53f0e0450df267aa`. The merge
tree exactly matches the reviewed and tested head. PR #33 remains unmerged.

## Review findings

- Onboarding maps only the initial device suggestion using the reviewed 18 aliases.
  Explicit edits, stored profiles, occurrence snapshots and the 484-name shared
  catalog retain their existing semantics. Alias targets and sampled offsets pass
  the Python/Java contract and the real installed Intl tests.
- Settings computes a partial PATCH from the last confirmed save/reload; unchanged
  unsupported timezones do not become writes. Empty saves, normalization, reload,
  explicit timezone changes and session renewal are covered.
- Maintenance claims retain durable attempt ordering and five-minute leases, use
  `FOR UPDATE SKIP LOCKED`, and claim only an immediately runnable batch. The
  240-second worker deadline includes claims and the final count. The service-only
  RPCs have an empty search path and explicit execution revocations from public,
  anonymous and authenticated roles. Claims cannot authorize a new deletion.
  Concurrency, restart fairness, expiry, limits and privilege denials pass against
  both migrated PostgreSQL versions. Scalar JSON/count responses avoid PostgREST's
  set-returning row limit.
- Existing-project setup preserves the EAS project, Android package, Firebase
  project and signing key, and uses `npm ci`. The release runbook retains the
  migration-before-deployment requirement and the warning that checked-in Render
  settings do not change the existing live service.

## Dependency investigation: no verified compatible release fix

The committed SDK 57 lockfile already resolves Expo **57.0.31** and CLI
**57.0.32**, the latest stable SDK 57 versions observed in the npm registry.
The fresh unfiltered audit still exits 1 with **five high affected package nodes
from two underlying advisories**. The dependency-audit workflow is unchanged.
No dependency versions, package identities, overrides or lockfile entries were
changed in this review.

### node-forge — GHSA-86w9-cpqp-85rv / CVE-2026-85393

Paths in the installed lockfile:

```text
expo@57.0.31 -> @expo/cli@57.0.32 -> node-forge@1.4.0
expo@57.0.31 -> @expo/cli@57.0.32
  -> @expo/code-signing-certificates@0.0.6 -> node-forge@1.4.0
```

The [advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv)
affects `<=1.4.0` and lists no patched version. npm's latest published version is
still 1.4.0. The CLI accepts `^1.3.3`; upgrading the certificate helper to the
published 0.0.7 would still require vulnerable `node-forge ^1.4.0`.
The nested `DigestAlgorithm` sequence can contain extra unconsumed children
although the outer `DigestInfo` element count is checked.

Both proposed upstream fixes remain open and unmerged:
[#1152](https://github.com/digitalbazaar/forge/pull/1152), head
`ceba34402e329f0365134f23fe19898756527d65`, and
[#1158](https://github.com/digitalbazaar/forge/pull/1158), head
`f192c67ee5850e44296ef83d6a7b6df6552ba8bf`.
I read their diffs and review history. The former has a review noting a stale
`describe.only` that invalidates a full-suite claim; the latter is a newer
candidate, but still has no merged/published fix. I reproduced acceptance of the
synthetic malformed ASN.1 input from #1158 against the installed 1.4.0. This is a
primitive regression reproduction, not proof of an installed-app exploit.

**Upstream unblock:** an accepted, verified forge fix and a published compatible
release, followed by lockfile installation, signing/certificate interoperability
checks and the unmodified audit. Vendoring an unmerged cryptographic patch or
renaming it to evade the audit is not a verified upstream dependency resolution.

### Zod — GHSA-mrhx-c7xc-m3w5 / CVE-2023-54404

```text
expo@57.0.31 -> @expo/cli@57.0.32 -> zod@3.25.76
```

CLI 57.0.32 declares `zod ^3.25.76`; **3.25.76 is the latest published v3**.
The [advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
identifies 4.6.6 as the patched version; latest v4 is 4.6.7. The
[upstream fix](https://github.com/colinhacks/zod/commit/a0ebf970f2d752e5f58527cd2942ff48be4f46bd)
changes v4 sources. An isolated probe of `z.array(z.string()).max(1)` on 10,000
numeric elements produced:

| Loaded entry point | Validation issues |
|---|---:|
| Installed 3.25.76 | 10,001 |
| 4.6.7 root (v4) | 1 |
| 4.6.7/v3 compatibility export | 10,001 |

Thus a wrapper redirecting Expo to the new package's `/v3` export would retain
the vulnerable behavior. Switching the root to v4 exceeds the CLI's supported
range and changes validation semantics (the probe also confirms different
optional-default behavior); ordinary app tests do not establish compatibility
with every Expo DevTools/MCP consumer of its schema objects. The v4 patch also
leaves unbounded collections unchanged, as upstream documents.

**Upstream unblock:** a maintained v3-compatible security backport or an SDK 57
CLI release with a supported, tested fixed-Zod integration. No such release was
found. Neither an unsupported major override nor npm's suggested Expo 44.0.6
SDK downgrade was applied.

## Verification

All local checks below use the unchanged reviewed source. Runtime: Node 24.19.0,
npm 11.9.0, Python 3.12, and checksum-verified Temurin JDK 17.0.21 for Java checks.

| Check | Independent result |
|---|---|
| Clean locked mobile install | `npm ci --no-audit` passed; audit run separately without filtering |
| SDK dependency compatibility | Local bundled-SDK check reports up to date; offline mode warns that remote validation is unavailable |
| Mobile regression suite | 736 passed, zero failures/skips |
| TypeScript | Passed |
| PostgreSQL 16, all 17 migrations and full backend suite | 1,750 passed; three Java-dependent tests initially skipped |
| PostgreSQL 17, all 17 migrations and full backend suite | 1,750 passed; the same three Java-dependent tests initially skipped |
| Previously skipped Python/Java timezone contract | All three passed separately after JDK installation; no unresolved skips |
| JVM planner/journal suite | Passed |
| Local HTTP owner/social journey | Passed with real FastAPI/PostgREST/PostgreSQL, fixture Auth and fake pushes |
| Additional HTTP/adapter checks | Legacy name-only PATCH and explicit supported-zone PATCH passed; production adapter returned disjoint 1,000/201 claims and count 1,201 with PostgREST max rows 10 |
| Android Metro/Hermes export | Passed with an empty Metro cache; loopback fixture configuration, not an APK |
| Python advisory scan | 32 dependencies, zero known advisories |
| npm advisory scan | Failed as expected: five high package nodes, two advisories above |
| Follow-up evidence manifest and whitespace | All 25 source hashes and both artifact hashes matched; diff check passed |

The existing [native CI run](https://github.com/HaddadGavriel/HabbitTracker/actions/runs/40319901114)
was independently inspected, including its actual checkout and build logs. It
checked out merge ref `38f3a8f776aeab6b0e6d1b40b4c3772efba07d36`, whose tree
`10fbcbf1a1e426248838cd2f06383cb4a990d8dc` is byte-identical to the reviewed
head. Both isolated engine and full native module builds succeeded; **39 Android
adapter tests passed with zero failures/errors/skips**, and CI checked that the
full AAR contains the Expo bridge and exact shared timezone catalog. This native
build was not rerun locally: the workspace has no Android SDK. Mobile and backend
CI also passed for the same PR; dependency CI correctly failed only npm.

Fresh compact results, audit JSON, dependency paths and probe outputs are in
[the independent evidence directory](2026-10-26-independent-review/).
The complete source and dependency inputs match the reviewed commit; the
subsequent evidence commit changes documentation only.

## Remaining release boundaries

PR #33 remains a draft against main. No merge to main, shared migration,
deployment, Render change, cron activation, live Auth deletion, signing-key
creation/rotation or EAS build was performed. The SDK, application/signing
configuration, native module and audit gate are unchanged. Disposable local
HTTP/database services were removed after verification.

The [follow-up rollout and device gates](2026-10-26-followup.md) still apply:
ordered missing migrations, control of live auto-deployment, staging cron
recovery and alerts, leaked-password protection where supported, a build signed
with the existing key, and physical-device acceptance. No release-ready claim
is made.
