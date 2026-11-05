# Mobile excuses: owner and friend Android walkthrough

Use an Android development client against a compatible backend approved for
manual testing. Create onboarded accounts Alice (owner), Bob and Carol (friends),
with separate sessions, or sign out before switching accounts on one device.
Follow the [Friends](mobile-friends-walkthrough.md) and
[sharing](mobile-sharing-walkthrough.md) walkthroughs to establish accepted
friendships and explicit habit grants. Friendship alone does not share a habit.
The [excuse contract](excuses.md) defines finality, permissions, deadlines and
archival; [history](history.md) defines server-calculated streaks. No backend
contracts or migrations change, and no excuse notifications are delivered.

The steps below are a manual test plan, not a claim that device or live-service
verification has been performed. Use disposable fixtures for boundary/race cases;
production APIs accept no client clock override.

## Owner submission and details

1. As Alice, create an unshared daily binary habit and a target habit such as
   **Read**, 10 pages. Generate Today and record partial target progress, for
   example 3 pages. An owned, incomplete `in_progress` occurrence before its
   original server `closes_at` offers **Submit excuse**. Completed, pending,
   excused and missed occurrences cannot submit. The occurrence's stored date,
   timezone, name, target/unit and deadline remain distinct from later habit or
   profile edits.
2. Open the explanation form. Verify that it explains the permanent lock on
   ordinary completion/progress, that unshared submissions automatically approve,
   and that shared submissions need a currently authorized friend's decision.
   There is no withdrawal, explanation editing, replacement submission or owner
   self-approval after submission. Navigating away before submitting does not write.
3. Try empty and whitespace-only explanations, 1,001 Unicode code points, NUL
   and an unpaired surrogate using a controlled input fixture. All must fail
   validation without sending a write. Test one code point and exactly 1,000
   emoji: each emoji counts as one code point rather than two UTF-16 units.
   Leading/trailing whitespace is trimmed with Python `str.strip()` semantics,
   including U+0085 and U+001C–U+001F; U+FEFF is not stripped. Combining sequences
   count by code point, not visual character. Verify readable long-text errors.
4. Submit the unshared target explanation with surrounding whitespace. Use the
   response to verify **approved**, decision source **automatic**, submission
   and decision timestamps, no deciding friend, occurrence **excused**, progress
   **3 / 10 pages**, and `completed: false`. Today must stop offering ordinary
   completion/progress. Reopen the excuse from Today and inspect its inline details in
   **My habits → History**; the stored explanation, status, decision source and
   timestamps must agree. The owner can still inspect details while archived.
5. Explicitly share a separate habit with Bob, submit its Today excuse, and
   verify **pending** from the response with no decision source/time yet. Change
   sharing in another session just before submitting; the displayed result must
   follow the actual server response, including automatic approval if no valid
   recipients remained at submission, regardless of any earlier sharing screen.
6. Leave a form open across its original `closes_at`. At the closing instant and
   afterward submission is unavailable; a server `occurrence_closed` rejection
   must not show success or enable retrying a past occurrence. Alter the device
   timezone or the owner's current profile timezone/configuration and verify
   that these do not recalculate or extend the stored deadline. Reopen Today
   after midnight: yesterday's unsubmitted occurrence cannot be submitted from
   history or an old link.

## Errors and ambiguous writes

1. Force a recoverable rejected request or temporarily lose connectivity. Keep
   the explanation draft and show a useful error. Repeated taps must not create
   overlapping submissions. A retry must still satisfy the current occurrence's
   eligibility and original deadline.
2. Allow submission to commit but drop/delay its response. A timeout is not proof
   of failure. The client must read the existing excuse/current occurrence before
   enabling another submission; if that read fails, the next action retries the
   read and leaves submission blocked. Recovering an existing pending/approved
   excuse shows its real result without issuing another POST. Repeat with a
   `409 excuse_exists` response, including a stale form open in another session.
3. Test an ambiguous request that did not commit. Only after successful
   reconciliation establishes no existing excuse and a still-eligible current
   occurrence may the preserved explanation be submitted again. If reconciliation
   instead finds completion, a new server day, or a locked occurrence,
   keep submission unavailable. Ordinary progress writes must not become enabled
   from an old saved delta response or a stale Today response.
4. Delay requests while navigating away/back, refreshing, signing out, switching
   to Bob, or renewing a token. Old responses, drafts, errors and confirmations
   must not appear in another account. Reopening a screen with an unsettled write
   must reconcile before re-enabling its actions. Renewed requests use the current
   token; expired authentication must not create a success message.

## Friend decisions and access changes

1. As Bob, open **Home → Pending excuse decisions**. The list contains only currently
   actionable submissions, ordered by the server, including dates older than
   today. Alice's own pending submissions must not become self-approvable. Inspect
   an entry and check the owner's display name and `@username`, stored habit name, occurrence date/timezone, partial
   progress and explanation. Current edited habit settings must not replace
   those occurrence snapshots.
2. Choose **Approve excuse** or **Reject excuse**. Each requires explicit confirmation that the
   first valid decision is final. The confirmation names the owner by display
   name and `@username`, plus the stored habit name and occurrence date. Cancel performs no request. Approval produces
   **approved / friend / excused**; rejection produces
   **rejected / friend / missed**, with deciding user and server timestamp. Show
   success only for a confirmed result. Neither decision offers undo, editing or
   another decision; the owner's ordinary controls remain locked even if the
   friend rejected before midnight. Partial progress remains visible.
   Repeat with two friends sharing identically named habits for the same date,
   including friends with the same display name but different usernames. Each
   row and final result must identify the correct owner. With TalkBack, verify
   Approve, Reject, Confirm and Cancel labels include that owner's display name,
   username, habit and date; Confirm also says the decision is permanent. Decide
   the second friend's excuse and verify only that excuse changes. On revocation,
   backgrounding or account switching, the old identity and controls must clear
   with the explanation. Apply the `excuse_owner_identity` migration before the
   API/mobile release: missing or inconsistent owner identity blocks decisions.
3. Leave another pending excuse past the owner's midnight. Reopen Pending
   excuse decisions and decide it successfully; the original submission deadline is
   not a decision deadline. Return as Alice to Today, history and streaks, and as
   Bob to Friends' habits/detail. Refresh on revisit must show the server result
   and server-calculated streak. Pending segments retain the provisional label;
   never add to or recompute a streak locally.
4. Share one habit with Bob and Carol. Find the same pending excuse in both
   sessions, then confirm opposing decisions close together. Exactly one may
   win. On `excuse_already_decided`, the other session reads the actual result,
   removes decision controls and does not claim its own choice succeeded.
   Repeat with an ambiguous decision timeout and a failed reconciliation read;
   keep decision controls blocked until current state/access is known.
5. From **Friends' habits**, open the shared habit and read its accessible
   occurrence excuse. Repeat for pending, approved and rejected examples. Access
   to an excuse does not grant full owner history or ordinary habit editing,
   completion/progress, archive or restore controls.
6. Keep a pending decision/detail open while Alice revokes Bob's share, removes
   the friendship, or archives the habit. Refresh/refocus and try a captured old
   confirmation. A denied request must not show success; inaccessible details and
   actionable controls disappear, and the pending list removes the item. The
   backend deliberately does not distinguish missing from inaccessible excuses,
   so the UI must not claim to know which lifecycle change occurred.
7. Remove every valid recipient of another pending excuse. It stays pending
   indefinitely and continues to lock Alice's ordinary progress; losing all
   recipients does not auto-approve or reject it. Re-friending alone does not
   restore grants. An explicit valid grant to Bob or a newly accepted friend
   restores that recipient's ability to decide the existing pending excuse.
8. Archive a habit with a pending excuse. Alice can inspect it, while recipients
   cannot list/read/decide until restoration and valid sharing. An owner submission
   for an archived habit's retained eligible occurrence remains supported by the
   backend: retained valid grants still produce pending, not automatic approval.
   Restoring the habit permits a retained authorized friend to decide even after
   the original deadline. Friendship removal while archived deletes the grants;
   restoration alone must not restore those permissions.

## Validation and remaining manual checks

From `mobile/`, run:

```sh
npm test
npm run typecheck
```

From `backend/`, run the ordinary suite and, with `TEST_DATABASE_URL` pointing
only to a disposable local PostgreSQL database with the scaffold and all
migrations, the integration suites:

```sh
python -m pytest -q
python -m pytest -q tests/test_*_postgres.py
```

Mocked mobile tests exercise actual request/state/screen handlers. Backend tests
separately enforce deadline boundaries, locks, archived access, current grants,
late decisions, competing transactions and server streaks. A PostgreSQL scaffold
does not emulate Supabase Auth or PostgREST. Actual commands, pass counts, skips
and failures belong in the PR validation report.

Android emulator/physical-device rendering, keyboard/scroll behavior, accessibility
and screen-reader order, long explanations and large fonts, confirmation dialogs,
Back/deep links, background/foreground lifecycle, EAS builds, and live multi-account
Auth/API network races were not verified in this workspace. Run these checks on
an approved test environment before release. No shared migration, deployment,
merge or real excuse notification is part of this change.
