# Mobile habit sharing: two-user Android walkthrough

Use two onboarded test accounts, Alice and Bob, in an Android development client
against a compatible backend approved for manual testing. Use separate sessions,
or sign out before switching accounts on one device. The existing
[sharing](sharing.md) and [history/streak](history.md) contracts are unchanged.
The sharing feature adds no backend routes, migrations, broader permissions or
reminder buttons. Accessible excuse details and friend decisions are covered in
the [mobile excuse walkthrough](mobile-excuses-walkthrough.md).

## Owner permissions

1. As Alice, create two active habits, including a target habit such as **Read**
   with a target of 10 pages. Open **My habits → Manage sharing** on either card.
   The screen loads the owned habit, accepted friendships, and that habit's
   current grants. With no friends, it explains how to find friends. Habits start
   private; a pending request or accepted friendship must never create a grant.
2. Become friends with Bob through **Home → Friends**. Return to Manage sharing.
   Check that Bob's current display name and username appear as an accepted friend
   without view permission. Explicitly grant access to one habit. Confirm the
   pending indication, disabled repeated action, and refreshed server permission.
   The other habit must remain private. Revoke the grant and confirm that the
   server permission changes back. Reload or refocus to verify persistence.
3. Archive the granted habit through its owner edit screen. Open **My habits →
   Archived → Manage sharing**. Existing grants remain and can be revoked or new
   ones explicitly granted. The screen explains that recipients cannot view an
   archived habit. Restore it: only retained grants become usable again.
4. While Manage sharing remains open, remove the friendship from another session.
   Refresh or foreground the app. Bob must disappear from accepted recipients
   and the old grant must disappear. A grant rejected with `friendship_required`
   must reconcile the lists and cannot report success. Become friends again;
   the new relationship has no grant. Refresh and explicitly share again if
   desired. A captured old button handler must not grant for the replacement
   friendship.
5. Use controlled API delays/failures for grant and revoke. A pending request
   must prevent duplicate changes. A lost response or timeout may have committed;
   reconciliation reads current state without automatically repeating the write.
   If that read fails, keep changes blocked and use the working server-state
   retry. Confirmed-write refresh failures also retry the read. Ordinary rejected
   actions show meaningful errors and allow an appropriate retry. Navigate away
   and back while a write is pending: the new screen must still wait for settlement
   and reconciliation.

## Recipient views

1. As Bob, open **Home → Friends’ habits**. Before an explicit grant the list is
   empty, even when Alice is an accepted friend. After Alice grants one active
   habit, refresh and open its detail. Both screens show Alice's public display
   name/username, current configuration, owner-local date and timezone, due-today
   status, today's occurrence (if present), and the server's current streak.
   There are no edit, archive, restore, completion, progress, full-history or
   reminder controls. An occurrence with an excuse links to its accessible details;
   authorized friend decisions use the separate excuse workflow.
2. Configure owners in different timezones using the existing profile API, for
   example `Asia/Tokyo` and `Pacific/Honolulu`. Share habits from both owners with
   Bob. At a UTC instant when their dates differ, each card must retain its own
   server date/timezone. Changing Bob's or the device's timezone must not change
   those values. Check the occurrence's stored timezone and original deadline
   separately when the owner has travelled since generation.
3. Generate an occurrence for **Read**, record 10 pages as Alice, then change the
   current name, target and unit to **Read chapters**, 20 chapters. Bob's refreshed
   view must distinguish current settings from today's snapshot: today's name
   remains Read and its progress remains **10 / 10 pages**, completed, with the
   original deadline. It must not show 10 / 20 chapters for that occurrence.
4. Share a selected-weekday habit with no occurrence for the owner's current day.
   It remains listed with no occurrence due today and its current streak. A
   timezone-transition null occurrence is handled the same way, without inventing
   a zero-progress task or a missed state. Check completed, in-progress, missed,
   pending-excuse and excused read-only states using suitable backend fixtures.
   A provisional streak is visibly labelled; its value comes from the shared
   response even on a day with no occurrence.
5. Keep a shared detail open, then revoke its grant as Alice. Refresh the detail:
   an inaccessible response removes the previously displayed detail and provides
   a safe return to Friends’ habits. Repeat with archival and friendship removal.
   Restoring the habit makes retained grants visible on a fresh read; re-friending
   alone does not. List refresh removes inaccessible entries. The backend uses
   the same inaccessible response for all of these cases, so the UI must not
   claim to know which one occurred.
6. Verify focus and explicit refresh on both screens, including empty lists.
   Read failures clear shared data and provide retry, rather than continuing to
   present an old response as currently authorized. Delayed older successes or
   failures must not restore data after a newer request, denial, navigation to
   another habit, sign-out, account switch, or token change. Sign-out and incomplete
   onboarding must protect all sharing routes, including direct links and Back.

## Validation

Run from `mobile/`:

```sh
npm test
npm run typecheck
```

Automated tests run the actual API helpers, stores, screen handlers, Home links
and protected route tree with mocked Auth/API/native components. They cover
private defaults, selective grants/revokes, archive/restore, friendship removal
and re-friending, ambiguous writes/retries, account isolation, stale requests,
owner-local dates, snapshot/configuration differences, null occurrences and
server streaks. Existing backend tests separately verify database access and
lifecycle behavior; actual run results belong in the PR description.

Android emulator/physical-device rendering, keyboard/scroll/refresh gestures,
accessibility, Back navigation, EAS builds and live Auth/API behavior have not
been verified in this workspace. Check long names, large font sizes, screen-reader
labels, empty-list refresh gestures and normal navigation on a device before a
release. No shared database or real notifications are used by the mobile tests.
