# Profile settings and email recovery

## Behavior

Settings is available from Home only after authentication and profile loading. Email is read-only. Username, display name, and IANA timezone use the existing profile validation and `PATCH /profiles/me`. A successful response replaces the shared profile; no optimistic identity/timezone update occurs. Username conflicts and server-unavailable timezones keep the draft editable. A 401 permits one token renewal and retry; other errors do not automatically repeat a write. If the outcome is uncertain, use **Reload saved profile** before deciding to submit again.

Saves retain the latest same-account token and ignore results after sign-out, account changes (including A → B → A), or provider teardown. A confirmed save invalidates the session reference consumed by date-dependent stores: Today and history/streak refresh and reject older reads. Focus refreshes also reload those screens. Under backend policy, timezone changes affect future scheduling; existing occurrence local dates, timezone snapshots, and deadlines remain fixed. Device timezone is only an onboarding suggestion; Settings never writes it automatically.

**Forgot password or resend confirmation** on authentication screens opens email help. Requests share a 60-second in-process cooldown across navigation and display generic account-existence messages. Server rate limits may be longer. Recovery requests use `resetPasswordForEmail`; signup confirmations use `resend({ type: 'signup' })`. Sign-up, resend, and recovery explicitly request `habittrackerinfra://auth-callback`.

Native cold-start and warm-start links use `getInitialURL` plus a URL listener, subscribed before initial URL resolution. A newer warm link supersedes a delayed initial URL. Startup waits for restored account identity before checking a link for account mismatch. Expo Router's native-intent hook strips credentials from navigation paths; no raw link, token, provider error, or password is logged by this implementation.

Links are validated in an isolated, nonpersistent Supabase Auth client and verified with `getUser`. Only recovery and signup confirmation are supported. The ordinary app session is never replaced by an email link. If the link account differs from the signed-in account, the user must explicitly continue or cancel. Continuing recovery changes only the linked account's password; the current app account remains signed in. The account check runs again before password submission. Recovery routes have priority over Home even when the app already has a ready session. Confirmation displays success and returns to manual sign-in. Password-update errors retain the recovery form with cancel/back navigation. The isolated client is disposed when released; recovery state does not survive process termination. Open a fresh email link after terminating the app mid-recovery.

Accepted native URIs are `habittrackerinfra://auth-callback` (also triple-slash form), plus the existing scheme's root callback `habittrackerinfra://` for earlier email redirects. Existing non-auth app URI paths remain unchanged. Query or fragment credentials may contain either `token_hash` and `type`, or `access_token`, `refresh_token`, and `type`. Optional bearer/expiry metadata is validated. Duplicate/unknown parameters, mixed credential formats, provider errors, unsupported routes/types, and PKCE `code` callbacks fail closed. This app explicitly uses the implicit flow; do not configure PKCE-only email redirects. Link verification rejects expired/used token hashes and invalid/revoked sessions. Supabase can renew a still-valid implicit session using its refresh token; implicit session URLs are bearer credentials, not an independently one-time token. Duplicate delivery during an active flow is ignored; opening an already handled link later in the same process displays a fresh-link error. For server-enforced one-time verification across app restarts, use the token-hash templates below.

No email-change, social-login, or account-deletion flow is added. Android package `com.haddadgavriel.habittracker`, scheme `habittrackerinfra`, and EAS project `4f31560d-6323-41f7-ae0a-f792a4814c98` are unchanged.

## External Supabase setup — not performed by this PR

These steps require a project administrator. No live configuration was changed and no test emails were sent during implementation.

1. In **Authentication → Providers → Email**, enable email/password sign-in. Enable **Confirm email** if signup confirmation is desired. Keep your chosen password policy; the new-password form handles service rejections. `resend` applies to signup confirmations supported by Supabase, not arbitrary sign-in or email-change messages.
2. In **Authentication → URL Configuration → Redirect URLs**, add the exact `habittrackerinfra://auth-callback`. Retain `habittrackerinfra://` if it was already used by older emails. Do not remove existing redirects needed by other clients. A wildcard is unnecessary. Keep the existing Site URL for other clients; mobile requests provide their own redirect explicitly.
3. In **Authentication → Email Templates**, configure these mobile templates for server-enforced one-time token-hash verification (preserve the template's surrounding HTML/branding):

   **Confirm signup**:

   ```html
   <a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&amp;type=signup">Confirm email</a>
   ```

   **Reset password**:

   ```html
   <a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&amp;type=recovery">Reset password</a>
   ```

   The app always supplies the callback without a query, so the `?` above is intentional. These templates send the hash directly to the app, where `verifyOtp` consumes it; do not wrap it in an additional `/verify` link or use a PKCE code exchange. If the project also serves web clients, have an administrator design compatible templates/HTTPS routing before changing shared templates. Default `{{ .ConfirmationURL }}` templates also work for implicit session callbacks to this URI, subject to the bearer-session reuse limitation described above. Custom templates using `{{ .SiteURL }}` instead of `{{ .RedirectTo }}` will bypass the requested mobile destination and must be corrected.
4. Configure production SMTP/delivery as needed in **Authentication → Email**, and review **Rate Limits**, email OTP expiry, and password/security policies. Keep provider limits; the client cooldown supplements them. Disable email click tracking/link rewriting that consumes or damages one-time links. Do not put service-role keys or email credentials in the app.
5. Use an installed Android development/preview build with the existing public Supabase/API environment values. Expo Go's `exp://` URLs and arbitrary HTTPS links are deliberately not accepted as authentication callbacks. No native identity change or new URI scheme is required.

## Validation and device walkthrough

Automated Node tests mock all network/Auth calls. They exercise actual session/date stores, link parsing/controller, cold/warm listener, route guards, native path sanitization, settings screen events, API PATCH contract, email cooldowns, and password failures. They do not send email. Run `npm test` and `npm run typecheck` in `mobile/`.

Still requires manual validation on an Android build after external setup (not performed here):

1. Save normalized username/display name/timezone; try a taken username, invalid IANA name, API failure, expired session, and ambiguous save followed by reload. Navigate back and sign out from errors. Switch accounts during slow saves and confirm old data never appears.
2. Open Today/history, change timezone in Settings, and return. Confirm new server dates/streaks load while historical occurrence dates/deadlines stay fixed. Change the device timezone and confirm the account profile stays unchanged.
3. With intentionally authorized email delivery, request a recovery email, force-close, then open its link. Repeat with the app warm, signed out, signed in as the same account, and signed in as another account. Verify explicit mismatch continue/cancel, new-password routing, and Android Back protection. Cancel and open the same consumed token-hash link again, then request a fresh link. Verify expired and malformed links offer back navigation and do not expose credentials.
4. Confirm signup using cold/warm links. Verify success returns to manual sign-in without replacing any existing account. Try resend within the cooldown and after it; check rate-limited/unavailable delivery states.
5. Try mismatched/weak/reused passwords, disconnected password update, and expired recovery credentials. Verify failures remain in recovery with cancel, duplicate taps do not submit twice, successful updates clear passwords, and the new password works at the next intentional sign-in.

## Official references and installed versions

Reviewed current official documentation and the matching installed SDK source/API signatures on 2026-10-20. Lockfile versions: Supabase JS/Auth **2.117.2**, Expo **57.0.26**, Expo Router **57.0.24**, Expo Linking **57.0.11**. No dependency upgrades are included.

- [Supabase native mobile deep linking](https://supabase.com/docs/guides/auth/native-mobile-deep-linking): explicit redirects, `setSession`, manual link handling.
- [Supabase password authentication and recovery](https://supabase.com/docs/guides/auth/passwords): `resetPasswordForEmail`, token-hash verification, `updateUser`.
- [Supabase Auth 2.117.2 official source](https://github.com/supabase/supabase-js/blob/v2.117.2/packages/core/auth-js/src/GoTrueClient.ts): reviewed the installed copy's `verifyOtp`, `setSession`, `getUser`, `resend`, `resetPasswordForEmail`, `updateUser`, and client disposal behavior.
- [Expo SDK 57 Linking](https://docs.expo.dev/versions/v57.0.0/sdk/linking/) and [linking into your app](https://docs.expo.dev/linking/into-your-app/): initial URL and URL subscriptions with a registered custom scheme.
- [Expo Router native intent](https://docs.expo.dev/router/advanced/native-intent/) and [protected routes](https://docs.expo.dev/router/advanced/protected/): checked against installed Router 57 native-intent/link subscription and protected-stack implementation.

Notification controls are also available in Settings. See [mobile notifications](mobile-notifications.md)
for explicit permission/enable, Android settings, session-aware registration,
owner-scoped unregister, and offline sign-out recovery. Diagnostics uses the same
service. A cleanup warning can remain visible after successful local sign-out;
local Auth state and confirmed remote device removal are separate outcomes.
