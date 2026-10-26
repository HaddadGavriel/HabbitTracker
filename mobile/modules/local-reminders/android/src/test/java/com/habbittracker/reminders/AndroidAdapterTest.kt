package com.habbittracker.reminders

import android.app.AlarmManager
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.ResolveInfo
import android.app.Notification
import android.util.AtomicFile
import java.io.FileOutputStream
import java.io.IOException
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.RealObject
import org.robolectric.shadow.api.Shadow
import org.robolectric.util.ReflectionHelpers.ClassParameter
import org.robolectric.shadows.ShadowNotificationManager
import android.os.SystemClock
import android.provider.Settings
import android.app.NotificationManager
import androidx.work.testing.WorkManagerTestInitHelper
import androidx.work.testing.TestListenableWorkerBuilder
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowAlarmManager

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], shadows = [FailingAtomicFile::class, FailingNotifications::class])
class AndroidAdapterTest {
  private val context: Context get() = RuntimeEnvironment.getApplication()
  private val owner = "aaaaaaaa-1111-4111-8111-111111111111"
  @Before fun setup() {
    FailingAtomicFile.writesBeforeFailure = -1
    FailingAtomicFile.silentCommitFailure = false
    FailingNotifications.fail = false
    FailingNotifications.posts = 0
    shadowOf(context.packageManager).addResolveInfoForIntent(
      Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setPackage(context.packageName),
      ResolveInfo().apply { activityInfo = ActivityInfo().apply {
        packageName = context.packageName; name = "com.habbittracker.MainActivity"
      } })
    context.noBackupFilesDir.listFiles()?.forEach { it.delete() }
    WorkManagerTestInitHelper.initializeTestWorkManager(context)
  }
  private fun plan() = JSONObject().put("version", 1).put("owner_id", owner)
    .put("server_time", "2026-10-21T00:00:00Z").put("local_date", "2026-10-21").put("timezone", "UTC")
    .put("effective", JSONArray()).put("future", JSONArray().put(JSONObject().put("habit_id", owner)
      .put("schedule", "daily").put("weekdays", JSONArray()).put("reminder_times", JSONArray().put("08:00"))
      .put("eligible_from", "2026-10-22")))
  @Test fun durableReplacementRebootRepairAndCancel() {
    val lease = Engine.acquire(context, owner)
    val clock = SystemClock.elapsedRealtime()
    Engine.replace(context, lease, plan().toString(), clock)
    assertTrue(context.noBackupFilesDir.resolve("local-reminders-v1.json").exists())
    val alarm = context.getSystemService(AlarmManager::class.java)
    assertEquals(1, shadowOf(alarm).scheduledAlarms.size)
    // Duplicate reconciliation replaces the same PendingIntent, not another queue entry.
    Engine.repair(context)
    assertEquals(1, shadowOf(alarm).scheduledAlarms.size)
    alarm.cancel(requireNotNull(requireNotNull(shadowOf(alarm).nextScheduledAlarm).operation))
    Engine.repair(context)
    assertEquals(1, shadowOf(alarm).scheduledAlarms.size)
    assertEquals("cancelled", Engine.cancel(context, lease)["status"])
    assertEquals(0, shadowOf(alarm).scheduledAlarms.size)
    assertEquals("cancelled", Engine.repair(context)["status"])
  }
  @Test fun staleOwnerCannotReplaceOrCancelNewOwner() {
    val old = Engine.acquire(context, owner)
    val next = Engine.acquire(context, "bbbbbbbb-2222-4222-8222-222222222222")
    assertNotEquals(old, next)
    assertEquals("stale_lease", Engine.cancel(context, old)["status"])
    try { Engine.replace(context, old, plan().toString(), SystemClock.elapsedRealtime()); fail() }
    catch (_: IllegalStateException) {}
    assertEquals("cancelled", Engine.cancel(context, next)["status"])
  }
  @Test fun exactAlarmDenialFallsBackAndReportsInexact() {
    val alarm = context.getSystemService(AlarmManager::class.java)
    ShadowAlarmManager.setCanScheduleExactAlarms(false)
    val lease = Engine.acquire(context, owner)
    assertEquals("inexact", Engine.replace(context, lease, plan().toString(), SystemClock.elapsedRealtime())["status"])
    assertEquals(1, shadowOf(alarm).scheduledAlarms.size)
  }
  @Test fun rebootRestoresButDoesNotClaimAuthoritativeClock() {
    val lease = Engine.acquire(context, owner)
    Engine.replace(context, lease, plan().toString(), SystemClock.elapsedRealtime())
    val current = Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, -1)
    Settings.Global.putInt(context.contentResolver, Settings.Global.BOOT_COUNT, current + 1)
    assertEquals("clock_unverified", Engine.repair(context)["status"])
    assertEquals(1, shadowOf(context.getSystemService(AlarmManager::class.java)).scheduledAlarms.size)
  }
  @Test fun notificationDenialPreservesPlanAndReportsBlocked() {
    val lease = Engine.acquire(context, owner)
    shadowOf(context.getSystemService(NotificationManager::class.java)).setNotificationsEnabled(false)
    assertEquals("permission_blocked", Engine.replace(context, lease, plan().toString(), SystemClock.elapsedRealtime())["status"])
    assertEquals(0, shadowOf(context.getSystemService(AlarmManager::class.java)).scheduledAlarms.size)
    shadowOf(context.getSystemService(NotificationManager::class.java)).setNotificationsEnabled(true)
    assertTrue(Engine.repair(context)["status"] in listOf("inexact", "scheduled_os_limited"))
    assertEquals(1, shadowOf(context.getSystemService(AlarmManager::class.java)).scheduledAlarms.size)
  }

  @Test fun interruptedAtomicWriteRecoversPriorCompletePlan() {
    val lease = Engine.acquire(context, owner)
    Engine.replace(context, lease, plan().toString(), SystemClock.elapsedRealtime())
    val file = context.noBackupFilesDir.resolve("local-reminders-v1.json")
    file.copyTo(context.noBackupFilesDir.resolve("local-reminders-v1.json.bak"), overwrite = true)
    file.writeText("interrupted JSON")
    assertTrue(Engine.repair(context)["status"] in listOf("inexact", "scheduled_os_limited"))
    assertEquals(owner, JSONObject(file.readText()).getString("owner"))
    assertEquals(1, shadowOf(context.getSystemService(AlarmManager::class.java)).scheduledAlarms.size)
  }

  @Test fun effectiveSnapshotWinsOverFutureConfigurationAndDeviceZone() {
    java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("Pacific/Honolulu"))
    val lease = Engine.acquire(context, owner)
    val value = plan().put("effective", JSONArray().put(JSONObject().put("habit_id", owner)
      .put("local_date", "2026-10-21").put("timezone", "UTC")
      .put("closes_at", "2026-10-22T00:00:00Z").put("reminder_times", JSONArray().put("08:00"))))
    value.getJSONArray("future").getJSONObject(0).put("reminder_times", JSONArray().put("09:00"))
    Engine.replace(context, lease, value.toString(), SystemClock.elapsedRealtime())
    val alarm = requireNotNull(shadowOf(context.getSystemService(AlarmManager::class.java)).peekNextScheduledAlarm())
    assertTrue(kotlin.math.abs(alarm.triggerAtTime - System.currentTimeMillis() - 8 * 60 * 60 * 1000L) < 1000)
  }

  @Test fun blockedLocalChannelDoesNotEraseHabitTimes() {
    context.getSystemService(NotificationManager::class.java).createNotificationChannel(
      android.app.NotificationChannel("local-habit-reminders", "My habit reminders", NotificationManager.IMPORTANCE_NONE))
    val lease = Engine.acquire(context, owner)
    assertEquals("permission_blocked", Engine.replace(context, lease, plan().toString(), SystemClock.elapsedRealtime())["status"])
    val saved = JSONObject(context.noBackupFilesDir.resolve("local-reminders-v1.json").readText())
    assertEquals("08:00", saved.getJSONObject("plan").getJSONArray("future").getJSONObject(0).getJSONArray("reminder_times").getString(0))
  }

  private fun todayPlan(serverTime: String = "00:00", times: List<String> = listOf("08:00")) = plan()
    .put("server_time", "2026-10-21T${serverTime}:00Z")
    .put("effective", JSONArray().put(JSONObject().put("habit_id", owner).put("local_date", "2026-10-21")
      .put("timezone", "UTC").put("closes_at", "2026-10-22T00:00:00Z").put("reminder_times", JSONArray(times))))
  private fun replace(lease: String, value: JSONObject) = Engine.replace(context, lease, value.toString(), SystemClock.elapsedRealtime())
  private fun saved() = JSONObject(context.noBackupFilesDir.resolve("local-reminders-v1.json").readText())
  private fun journal() = saved().getJSONObject("journal")
  private fun notification() = shadowOf(context.getSystemService(NotificationManager::class.java)).getNotification("local-reminders", 1)

  @Test fun packagedTimezoneContractResolvesEveryIdentifier() {
    val zones = requireNotNull(TimezonePolicy::class.java.getResourceAsStream("/timezones-v1.txt"))
      .bufferedReader().use { it.readLines() }.filter { it.isNotEmpty() && !it.startsWith("#") }
    assertEquals(484, zones.size)
    zones.forEach { assertNotNull(TimezonePolicy.resolve(it)) }
  }

  @Test fun unsupportedProfileAndSnapshotPlansPauseDurablyAndRecoverWithoutReplay() {
    ShadowAlarmManager.setCanScheduleExactAlarms(true)
    for (snapshot in listOf(false, true)) {
      Engine.cancelAll(context)
      val lease = Engine.acquire(context, owner)
      reconcile(lease, todayPlan(times = listOf("08:00", "09:00")))
      advanceAnchor("2026-10-21T08:00:00Z")
      Engine.repair(context, Engine.RepairReason.ALARM)
      assertEquals(1L, journal().getLong("total"))
      assertNotNull(notification())
      val before = journal().toString()
      val unsupported = todayPlan("08:05")
      if (snapshot) unsupported.getJSONArray("effective").getJSONObject(0).put("timezone", "EST")
      else unsupported.put("timezone", "EST")
      val rawPlan = unsupported.toString()
      assertEquals("unsupported_timezone", reconcile(lease, unsupported)["status"])
      assertEquals(rawPlan, saved().getJSONObject("plan").toString())
      assertEquals(before, journal().toString())
      assertTrue(saved().getBoolean("timezoneBlocked"))
      assertNull(notification())
      assertEquals(0, shadowOf(context.getSystemService(AlarmManager::class.java)).scheduledAlarms.size)
      assertEquals(lease, Engine.acquire(context, owner)) // same-owner restart retains the pause
      for (reason in Engine.RepairReason.values()) {
        assertEquals("unsupported_timezone", Engine.repair(context, reason)["status"])
        assertEquals(before, journal().toString())
      }
      if (snapshot) {
        // Fixing the profile cannot reinterpret the still-eligible immutable snapshot.
        unsupported.put("timezone", "UTC")
        assertEquals("unsupported_timezone", reconcile(lease, unsupported)["status"])
        assertEquals("EST", saved().getJSONObject("plan").getJSONArray("effective").getJSONObject(0).getString("timezone"))
      }
      // Next day's fresh plan no longer includes the expired unsupported snapshot.
      val supported = plan().put("local_date", "2026-10-22").put("server_time", "2026-10-22T00:00:00Z")
      supported.getJSONArray("future").getJSONObject(0).put("eligible_from", "2026-10-23")
      assertEquals("scheduled_os_limited", reconcile(lease, supported)["status"])
      assertFalse(saved().has("timezoneBlocked"))
      assertEquals(1L, journal().getLong("total"))
      assertFalse(journal().getBoolean("presentationPending"))
      assertNull(notification())
      repeat(3) { Engine.repair(context, Engine.RepairReason.ALARM) }
      assertEquals(1L, journal().getLong("total"))
      advanceAnchor("2026-10-23T08:00:00Z")
      repeat(3) { Engine.repair(context, Engine.RepairReason.ALARM) }
      assertEquals(2L, journal().getLong("total"))
      assertEquals(1, shadowOf(context.getSystemService(AlarmManager::class.java)).scheduledAlarms.size)
    }
  }

  @Test fun emptyUnsupportedProfilePlanStillCancelsPreviouslyScheduledAlarms() {
    val lease = Engine.acquire(context, owner)
    reconcile(lease, todayPlan())
    val empty = plan().put("timezone", "localtime").put("future", JSONArray())
    assertEquals("unsupported_timezone", reconcile(lease, empty)["status"])
    assertEquals(0, shadowOf(context.getSystemService(AlarmManager::class.java)).scheduledAlarms.size)
    empty.put("timezone", "UTC")
    assertEquals("idle", reconcile(lease, empty)["status"])
  }

  @Test fun preContractPersistedSnapshotsAndBacklogAreQuarantinedBeforeAnyDelivery() {
    ShadowAlarmManager.setCanScheduleExactAlarms(true)
    for (backlog in listOf(false, true)) {
      Engine.cancelAll(context)
      val lease = Engine.acquire(context, owner)
      reconcile(lease, todayPlan())
      val legacy = saved()
      if (backlog) {
        val rule = JSONObject().put("habit", owner).put("zone", "HST").put("start", "2026-10-20")
          .put("date", "2026-10-20").put("closes", "2026-10-21T10:00:00Z")
          .put("weekdays", JSONArray()).put("time", "08:00")
        legacy.getJSONObject("journal").put("backlog", JSONArray().put(JSONObject()
          .put("rules", JSONArray().put(rule)).put("cursor", "2026-10-20T00:00:00Z").put("until", "2026-10-21T00:00:00Z")))
      } else legacy.getJSONObject("plan").getJSONArray("effective").getJSONObject(0).put("timezone", "right/UTC")
      val evidence = legacy.getJSONObject("journal").toString()
      context.noBackupFilesDir.resolve("local-reminders-v1.json").writeText(legacy.toString())
      assertEquals("unsupported_timezone", Engine.repair(context, Engine.RepairReason.ALARM)["status"])
      assertEquals(evidence, journal().toString())
      assertEquals(0, shadowOf(context.getSystemService(AlarmManager::class.java)).scheduledAlarms.size)
      assertNull(notification())
      assertEquals("scheduled_os_limited", reconcile(lease, plan())["status"])
      assertEquals(0L, journal().getLong("total"))
      assertEquals(0, journal().getJSONArray("backlog").length())
    }
  }

  @Test fun unsupportedTimezoneCannotCrossAnOwnerLeaseBoundary() {
    ShadowAlarmManager.setCanScheduleExactAlarms(true)
    val lease = Engine.acquire(context, owner)
    assertEquals("unsupported_timezone", reconcile(lease, plan().put("timezone", "EST"))["status"])
    val nextOwner = "bbbbbbbb-2222-4222-8222-222222222222"
    val next = Engine.acquire(context, nextOwner)
    assertEquals("scheduled_os_limited", reconcile(next, plan().put("owner_id", nextOwner))["status"])
    try { reconcile(lease, plan().put("timezone", "EST")); fail("stale lease must fail") }
    catch (_: IllegalStateException) {}
    assertEquals(nextOwner, saved().getString("owner"))
    assertFalse(saved().has("timezoneBlocked"))
    assertEquals(1, shadowOf(context.getSystemService(AlarmManager::class.java)).scheduledAlarms.size)
  }

  @Test fun overdueReminderSurvivesReplacementAndRepeatedRefreshWithoutRetroactiveNewTimes() {
    val lease = Engine.acquire(context, owner)
    replace(lease, todayPlan())
    val refresh = todayPlan("08:05", listOf("07:00", "08:00"))
    replace(lease, refresh)
    repeat(5) { replace(lease, refresh) }
    assertEquals(1L, journal().getLong("total"))
    assertFalse(journal().getBoolean("presentationPending"))
    assertTrue(notification().extras.getString(Notification.EXTRA_TEXT)!!.startsWith("1 habit"))
    assertEquals(1, shadowOf(context.getSystemService(NotificationManager::class.java)).size())
    val tap = shadowOf(notification().contentIntent).savedIntent
    assertEquals(owner, tap.getStringExtra("local_reminder_owner"))
    assertEquals("local_habit_reminder", tap.getStringExtra("local_reminder_type"))
    assertEquals(lease, tap.getStringExtra("local_reminder_lease"))
  }

  @Test fun replacementCancelsRemovedCurrentProjectionButKeepsAuthoritativeSnapshotOnArchive() {
    val lease = Engine.acquire(context, owner)
    val prediction = plan().put("server_time", "2026-10-20T00:00:00Z").put("local_date", "2026-10-20")
    prediction.getJSONArray("future").getJSONObject(0).put("eligible_from", "2026-10-21")
    replace(lease, prediction)
    replace(lease, plan().put("server_time", "2026-10-21T08:05:00Z")) // no authoritative today row
    assertEquals(0L, journal().getLong("total"))
    // Start a new lease, then archive future rules while retaining today's snapshot.
    Engine.cancel(context, lease)
    val next = Engine.acquire(context, owner)
    replace(next, todayPlan())
    assertEquals("idle", replace(next, todayPlan("08:05").put("future", JSONArray()))["status"])
    assertEquals(1L, journal().getLong("total"))
    assertEquals(0, shadowOf(context.getSystemService(AlarmManager::class.java)).scheduledAlarms.size)
  }

  @Test fun backlogExceeding64BatchesSurvivesDiskReloadsAndPlanReplacements() {
    val lease = Engine.acquire(context, owner)
    val times = (1..130).map { "%02d:%02d".format(it / 60, it % 60) }
    replace(lease, todayPlan(times = times))
    assertEquals("catchup_pending", replace(lease, todayPlan("03:00", times))["status"])
    assertEquals(64L, journal().getLong("total"))
    assertTrue(journal().getJSONArray("backlog").length() > 0)
    assertEquals("catchup_pending", replace(lease, todayPlan("03:01", times))["status"])
    assertEquals(128L, journal().getLong("total"))
    Engine.repair(context) // every entry point reconstructs the coordinator from disk
    assertEquals(130L, journal().getLong("total"))
    assertEquals(0, journal().getJSONArray("backlog").length())
    replace(lease, todayPlan("03:02", times))
    assertEquals(130L, journal().getLong("total"))
    assertTrue(notification().extras.getString(Notification.EXTRA_TEXT)!!.startsWith("130 habit"))
    assertEquals(1, shadowOf(context.getSystemService(AlarmManager::class.java)).scheduledAlarms.size)
  }

  @Test fun expiredStoredSnapshotStillCountsWhenItLeavesTheOpenPlanProjection() {
    val lease = Engine.acquire(context, owner)
    val snapshot = todayPlan()
    snapshot.getJSONArray("effective").getJSONObject(0).put("closes_at", "2026-10-21T08:01:00Z")
    replace(lease, snapshot)
    replace(lease, plan().put("server_time", "2026-10-21T08:05:00Z"))
    assertEquals(1L, journal().getLong("total"))
    assertNotNull(notification())
  }

  @Test fun historicalBacklogSurvivesProfileDateRollbackBetweenBoundedPasses() {
    val lease = Engine.acquire(context, owner)
    val initial = plan().put("server_time", "2026-10-20T00:00:00Z").put("local_date", "2026-10-20")
    initial.getJSONArray("future").getJSONObject(0).put("eligible_from", "2026-10-21")
    replace(lease, initial)
    val current = todayPlan().put("server_time", "2027-03-01T08:05:00Z").put("local_date", "2027-03-01")
    current.getJSONArray("effective").getJSONObject(0).put("local_date", "2027-03-01").put("closes_at", "2027-03-02T00:00:00Z")
    current.getJSONArray("future").getJSONObject(0).put("eligible_from", "2027-03-02")
    assertEquals("catchup_pending", replace(lease, current)["status"])
    assertEquals(64L, journal().getLong("total"))
    current.put("local_date", "2027-02-28").put("timezone", "Pacific/Honolulu")
    assertEquals("catchup_pending", replace(lease, current)["status"])
    assertEquals(128L, journal().getLong("total"))
    Engine.repair(context)
    assertEquals(132L, journal().getLong("total"))
    assertEquals(0, journal().getJSONArray("backlog").length())
  }

  @Test fun timezoneChangeRetainsSnapshotAndUsesNewFutureFloorWithoutReplay() {
    val lease = Engine.acquire(context, owner)
    replace(lease, todayPlan())
    val travel = todayPlan("08:05").put("timezone", "Pacific/Honolulu").put("local_date", "2026-10-20")
    replace(lease, travel)
    assertEquals(1L, journal().getLong("total"))
    val scheduled = requireNotNull(shadowOf(context.getSystemService(AlarmManager::class.java)).peekNextScheduledAlarm())
    val delay = java.time.Duration.between(java.time.Instant.parse("2026-10-21T08:05:00Z"),
      java.time.Instant.parse("2026-10-22T18:00:00Z")).toMillis()
    assertTrue(kotlin.math.abs(scheduled.triggerAtTime - System.currentTimeMillis() - delay) < 1000)
  }

  @Test fun earlierJournalCountMigratesToOutboxWithoutCountingAgain() {
    val lease = Engine.acquire(context, owner)
    val legacy = saved().put("plan", todayPlan()).put("cursor", "2026-10-21T00:00:00Z")
      .put("countedBatch", "2026-10-21T08:00:00Z").put("unreadCount", 1)
    context.noBackupFilesDir.resolve("local-reminders-v1.json").writeText(legacy.toString())
    replace(lease, todayPlan("08:05"))
    assertEquals(1L, journal().getLong("total"))
    assertFalse(journal().getBoolean("presentationPending"))
    assertTrue(notification().extras.getString(Notification.EXTRA_TEXT)!!.startsWith("1 habit"))
    assertFalse(saved().has("countedBatch"))
  }

  @Test fun failedReplacementWriteKeepsPreviousPlanAndOverdueWork() {
    val lease = Engine.acquire(context, owner)
    replace(lease, todayPlan())
    FailingAtomicFile.writesBeforeFailure = 0
    try { replace(lease, todayPlan("08:05")); fail("write should fail") } catch (_: IOException) {}
    assertEquals("2026-10-21T00:00:00Z", saved().getJSONObject("plan").getString("server_time"))
    replace(lease, todayPlan("08:06"))
    assertEquals(1L, journal().getLong("total"))
  }

  @Test fun failedConsumptionWriteDoesNotLoseOrCountReminder() {
    val lease = Engine.acquire(context, owner)
    replace(lease, todayPlan())
    FailingAtomicFile.writesBeforeFailure = 1 // replacement commits; consumption cannot commit
    assertEquals("repair_required", replace(lease, todayPlan("08:05"))["status"])
    assertEquals(0L, journal().getLong("total"))
    assertNull(notification())
    replace(lease, todayPlan("08:06"))
    assertEquals(1L, journal().getLong("total"))
    assertNotNull(notification())
  }

  @Test fun silentAtomicCommitFailureCannotReportReplacementSuccess() {
    val lease = Engine.acquire(context, owner)
    replace(lease, todayPlan())
    FailingAtomicFile.silentCommitFailure = true
    try { replace(lease, todayPlan("08:05")); fail("uncommitted replacement should fail") } catch (_: IOException) {}
    assertEquals("2026-10-21T00:00:00Z", saved().getJSONObject("plan").getString("server_time"))
    replace(lease, todayPlan("08:06"))
    assertEquals(1L, journal().getLong("total"))
  }

  @Test fun presentationFailureAndRefreshRetainOutboxWithoutDoubleCounting() {
    val lease = Engine.acquire(context, owner)
    replace(lease, todayPlan())
    FailingNotifications.fail = true
    assertEquals("repair_required", replace(lease, todayPlan("08:05"))["status"])
    repeat(3) { assertEquals("repair_required", replace(lease, todayPlan("08:06"))["status"]) }
    assertEquals(1L, journal().getLong("total"))
    assertTrue(journal().getBoolean("presentationPending"))
    assertNull(notification())
    FailingNotifications.fail = false
    Engine.repair(context)
    assertEquals(1L, journal().getLong("total"))
    assertFalse(journal().getBoolean("presentationPending"))
    assertTrue(notification().extras.getString(Notification.EXTRA_TEXT)!!.startsWith("1 habit"))
  }

  @Test fun crashAfterPresentationBeforeOutboxCommitRetriesSameCountAndOldTapCannotEraseNewWork() {
    val lease = Engine.acquire(context, owner)
    replace(lease, todayPlan(times = listOf("08:00", "09:00")))
    FailingAtomicFile.writesBeforeFailure = 2 // replacement and consumption commit; presentation acknowledgement fails
    assertEquals("repair_required", replace(lease, todayPlan("08:05", listOf("08:00", "09:00")))["status"])
    assertEquals(1L, journal().getLong("total"))
    assertTrue(journal().getBoolean("presentationPending"))
    assertNotNull(notification())
    Engine.repair(context)
    assertEquals(1L, journal().getLong("total"))
    val oldTap = notification().contentIntent
    FailingNotifications.fail = true
    replace(lease, todayPlan("09:05", listOf("08:00", "09:00")))
    assertEquals(2L, journal().getLong("total"))
    val oldSequence = shadowOf(oldTap).savedIntent.getLongExtra("local_reminder_sequence", 0)
    assertEquals(1L, oldSequence) // failed presentation must not rewrite the visible notification's PendingIntent
    Engine.acknowledge(context, owner, lease, oldSequence)
    assertEquals(1L, journal().getLong("acknowledged"))
    assertTrue(journal().getBoolean("presentationPending"))
    FailingNotifications.fail = false
    Engine.repair(context)
    assertTrue(notification().extras.getString(Notification.EXTRA_TEXT)!!.startsWith("1 habit"))
    Engine.acknowledge(context, owner, lease, 2)
    Engine.repair(context)
    assertEquals(2L, journal().getLong("total"))
    assertEquals(2L, journal().getLong("acknowledged"))
  }

  @Test fun cancellationAndAccountReplacementDiscardOutstandingWorkAndFenceOldTaps() {
    val lease = Engine.acquire(context, owner)
    replace(lease, todayPlan())
    FailingNotifications.fail = true
    replace(lease, todayPlan("08:05"))
    Engine.cancel(context, lease)
    assertEquals("cancelled", Engine.repair(context)["status"])
    val next = Engine.acquire(context, owner)
    FailingNotifications.fail = false
    replace(next, todayPlan())
    replace(next, todayPlan("08:05"))
    Engine.acknowledge(context, owner, lease, 100) // prior installation-enable epoch cannot acknowledge new count
    assertEquals(0L, journal().getLong("acknowledged"))
    Engine.acquire(context, "bbbbbbbb-2222-4222-8222-222222222222")
    assertNull(notification())
    assertEquals("stale_lease", Engine.cancel(context, next)["status"])
    assertEquals("awaiting_plan", Engine.repair(context)["status"])
  }

  private fun reconcile(lease: String, value: JSONObject) =
    Engine.reconcile(context, lease, value.toString(), SystemClock.elapsedRealtime())
  private fun advanceAnchor(time: String) {
    val value = saved().put("anchor", time).put("elapsed", SystemClock.elapsedRealtime())
    context.noBackupFilesDir.resolve("local-reminders-v1.json").writeText(value.toString())
  }
  private fun alarmDelay() = requireNotNull(shadowOf(context.getSystemService(AlarmManager::class.java))
    .peekNextScheduledAlarm()).triggerAtTime - System.currentTimeMillis()

  @Test fun productReconcileSkipsMissedTimesAndDoesNotReplayAfterRestart() {
    val lease = Engine.acquire(context, owner)
    reconcile(lease, todayPlan(times = listOf("08:00", "09:00")))
    reconcile(lease, todayPlan("08:05", listOf("08:00", "09:00")))
    repeat(3) { Engine.repair(context); assertEquals(lease, Engine.acquire(context, owner)) }
    assertEquals(0L, journal().getLong("total"))
    assertEquals(0, journal().getJSONArray("backlog").length())
    assertNull(notification())
    assertTrue(kotlin.math.abs(alarmDelay() - 55 * 60 * 1000L) < 1000)
  }

  @Test fun productRoutineStatusWorkerAndClockRepairPreserveDelayedAlarmUntilBoundedDelivery() {
    val lease = Engine.acquire(context, owner)
    val value = todayPlan(times = listOf("08:00", "09:00"))
    val rows = value.getJSONArray("effective")
    rows.put(JSONObject(rows.getJSONObject(0).toString()).put("habit_id", "bbbbbbbb-2222-4222-8222-222222222222"))
    reconcile(lease, value)
    val cursor = journal().getString("cursor")
    advanceAnchor("2026-10-21T09:05:00Z")
    val worker = TestListenableWorkerBuilder<ReminderRepairWorker>(context).build()
    repeat(3) {
      Engine.repair(context) // status and reconstructed coordinator
      worker.doWork()
      for (action in listOf(Intent.ACTION_TIME_CHANGED, Intent.ACTION_TIMEZONE_CHANGED,
        AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED)) {
        Engine.repair(context, Engine.reasonForBroadcast(action))
      }
      assertEquals(cursor, journal().getString("cursor"))
      assertEquals(0L, journal().getLong("total"))
      assertNull(notification())
      assertTrue(kotlin.math.abs(alarmDelay()) < 1000)
      assertEquals(1, shadowOf(context.getSystemService(AlarmManager::class.java)).scheduledAlarms.size)
    }
    Engine.repair(context, Engine.reasonForBroadcast("com.habbittracker.REMINDER"))
    assertEquals(2L, journal().getLong("total")) // two habits at 08:00, no second batch for 09:00
    assertEquals(1, FailingNotifications.posts)
    assertTrue(notification().extras.getString(Notification.EXTRA_TEXT)!!.startsWith("2 habit"))
    repeat(3) { worker.doWork(); Engine.repair(context, Engine.RepairReason.ALARM) }
    assertEquals(2L, journal().getLong("total"))
    assertEquals(1, FailingNotifications.posts)
    assertTrue(kotlin.math.abs(alarmDelay() - (22 * 60 + 55) * 60 * 1000L) < 1000)
  }

  @Test fun productBootAndPackageRecoverySkipLongBacklogWithoutPreventingTheNextAlarm() {
    for (action in listOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED)) {
      Engine.cancelAll(context)
      val lease = Engine.acquire(context, owner)
      reconcile(lease, todayPlan(times = listOf("08:00", "09:00")))
      val posts = FailingNotifications.posts
      advanceAnchor("2030-01-01T09:05:00Z")
      Engine.repair(context, Engine.reasonForBroadcast(action))
      assertEquals(0L, journal().getLong("total"))
      assertEquals(0, journal().getJSONArray("backlog").length())
      assertNull(notification())
      assertTrue(kotlin.math.abs(alarmDelay() - (22 * 60 + 55) * 60 * 1000L) < 1000)
      advanceAnchor("2030-01-02T08:05:00Z")
      Engine.repair(context)
      assertTrue(kotlin.math.abs(alarmDelay()) < 1000)
      repeat(2) { Engine.repair(context, Engine.RepairReason.ALARM) }
      assertEquals(1L, journal().getLong("total"))
      assertEquals(posts + 1, FailingNotifications.posts)
    }
  }

  @Test fun productRoutineRepairDiscardsAmbiguousPresentationWithoutSkippingTheNextDelayedBatch() {
    val lease = Engine.acquire(context, owner)
    reconcile(lease, todayPlan(times = listOf("08:00", "09:00")))
    advanceAnchor("2026-10-21T08:00:00Z")
    FailingAtomicFile.writesBeforeFailure = 1
    assertEquals("repair_required", Engine.repair(context, Engine.RepairReason.ALARM)["status"])
    assertTrue(journal().getBoolean("presentationPending"))
    assertEquals(1, FailingNotifications.posts)
    val cursor = journal().getString("cursor")
    advanceAnchor("2026-10-21T09:05:00Z")
    repeat(3) { Engine.repair(context) }
    assertFalse(journal().getBoolean("presentationPending"))
    assertEquals(cursor, journal().getString("cursor"))
    assertEquals(1L, journal().getLong("total"))
    assertEquals(1, FailingNotifications.posts)
    assertTrue(kotlin.math.abs(alarmDelay()) < 1000)
    repeat(2) { Engine.repair(context, Engine.RepairReason.ALARM) }
    assertEquals(2L, journal().getLong("total"))
    assertEquals(2, FailingNotifications.posts)
  }

  @Test fun productFailedConsumptionRemainsDueAcrossRoutineRepair() {
    val lease = Engine.acquire(context, owner)
    reconcile(lease, todayPlan(times = listOf("08:00", "09:00")))
    val cursor = journal().getString("cursor")
    advanceAnchor("2026-10-21T09:05:00Z")
    FailingAtomicFile.writesBeforeFailure = 0
    assertEquals("repair_required", Engine.repair(context, Engine.RepairReason.ALARM)["status"])
    Engine.repair(context)
    assertEquals(cursor, journal().getString("cursor"))
    assertEquals(0L, journal().getLong("total"))
    assertEquals(0, FailingNotifications.posts)
    assertTrue(kotlin.math.abs(alarmDelay()) < 1000)
    repeat(2) { Engine.repair(context, Engine.RepairReason.ALARM) }
    assertEquals(1L, journal().getLong("total"))
    assertEquals(1, FailingNotifications.posts)
  }

  @Test fun productCompletionAndExcuseSuppressionKeepFutureDatesAndUndoUsesOnlyFutureTimes() {
    val lease = Engine.acquire(context, owner)
    reconcile(lease, todayPlan(times = listOf("08:00", "09:00")))
    Engine.suppress(context, lease, owner, "2026-10-21")
    assertTrue(kotlin.math.abs(alarmDelay() - 32 * 60 * 60 * 1000L) < 1000)
    assertEquals(0L, journal().getLong("total"))
    // Reopening receives a fresh server plan with the same immutable snapshot.
    reconcile(lease, todayPlan("08:05", listOf("08:00", "09:00")))
    assertTrue(kotlin.math.abs(alarmDelay() - 55 * 60 * 1000L) < 1000)
    assertNull(notification())
  }

  @Test fun localDateSuppressionWorksForOfflineRecurringPredictionAfterMidnight() {
    val lease = Engine.acquire(context, owner)
    reconcile(lease, plan())
    advanceAnchor("2026-10-22T07:00:00Z")
    Engine.suppress(context, lease, owner, "2026-10-22")
    Engine.repair(context)
    assertTrue(kotlin.math.abs(alarmDelay() - 25 * 60 * 60 * 1000L) < 1000)
    assertNull(notification())
    assertEquals(1, saved().getJSONArray("suppressed").length())
  }

  @Test fun productArchiveCancelsTodayFutureAndPresentedThenRestoreDoesNotCatchUp() {
    val lease = Engine.acquire(context, owner)
    reconcile(lease, todayPlan(times = listOf("08:00", "09:00")))
    advanceAnchor("2026-10-21T08:00:00Z")
    Engine.repair(context, Engine.RepairReason.ALARM)
    assertNotNull(notification())
    Engine.suppress(context, lease, owner, null)
    assertNull(notification())
    assertEquals(0, shadowOf(context.getSystemService(AlarmManager::class.java)).scheduledAlarms.size)
    reconcile(lease, todayPlan("08:05", listOf("08:00", "09:00")))
    assertNull(notification())
    assertEquals(1L, journal().getLong("total"))
    assertEquals(1L, journal().getLong("acknowledged"))
    assertTrue(kotlin.math.abs(alarmDelay() - 55 * 60 * 1000L) < 1000)
  }

  @Test fun productDelayedAlarmPostsOneBatchAndRestartDoesNotRepeatAmbiguousPresentation() {
    val lease = Engine.acquire(context, owner)
    reconcile(lease, todayPlan(times = listOf("08:00", "09:00")))
    advanceAnchor("2026-10-21T09:05:00Z")
    FailingAtomicFile.writesBeforeFailure = 1 // counted consumption commits; post acknowledgement fails
    assertEquals("repair_required", Engine.repair(context, Engine.RepairReason.ALARM)["status"])
    assertNotNull(notification())
    assertEquals(1L, journal().getLong("total"))
    assertTrue(journal().getBoolean("presentationPending"))
    Engine.repair(context) // recovery discards the ambiguous outbox instead of reposting
    assertFalse(journal().getBoolean("presentationPending"))
    assertEquals(1L, journal().getLong("total"))
    assertTrue(kotlin.math.abs(alarmDelay() - (22 * 60 + 55) * 60 * 1000L) < 1000)
  }

  @Test fun productPermissionRevocationClearsPresentedAndGrantSkipsElapsedReminders() {
    val lease = Engine.acquire(context, owner)
    reconcile(lease, todayPlan(times = listOf("08:00", "09:00")))
    advanceAnchor("2026-10-21T08:00:00Z")
    Engine.repair(context, Engine.RepairReason.ALARM)
    assertNotNull(notification())
    shadowOf(context.getSystemService(NotificationManager::class.java)).setNotificationsEnabled(false)
    assertEquals("permission_blocked", Engine.repair(context)["status"])
    assertTrue(saved().getBoolean("recoverMissed"))
    assertNull(notification())
    assertEquals(0, shadowOf(context.getSystemService(AlarmManager::class.java)).scheduledAlarms.size)
    advanceAnchor("2026-10-21T09:05:00Z")
    shadowOf(context.getSystemService(NotificationManager::class.java)).setNotificationsEnabled(true)
    Engine.repair(context)
    assertNull(notification())
    assertEquals(1L, journal().getLong("total"))
    assertFalse(saved().has("recoverMissed"))
    assertTrue(kotlin.math.abs(alarmDelay() - (22 * 60 + 55) * 60 * 1000L) < 1000)
  }

  @Test fun productPermissionRecoveryFlagAndSkippedCursorCommitTogether() {
    val lease = Engine.acquire(context, owner)
    reconcile(lease, todayPlan(times = listOf("08:00", "09:00")))
    val cursor = journal().getString("cursor")
    shadowOf(context.getSystemService(NotificationManager::class.java)).setNotificationsEnabled(false)
    Engine.repair(context)
    advanceAnchor("2026-10-21T09:05:00Z")
    shadowOf(context.getSystemService(NotificationManager::class.java)).setNotificationsEnabled(true)
    FailingAtomicFile.writesBeforeFailure = 0
    assertEquals("repair_required", Engine.repair(context, Engine.RepairReason.ALARM)["status"])
    assertTrue(saved().getBoolean("recoverMissed"))
    assertEquals(cursor, journal().getString("cursor"))
    Engine.repair(context)
    assertFalse(saved().has("recoverMissed"))
    assertEquals(0L, journal().getLong("total"))
    assertNull(notification())
    assertTrue(kotlin.math.abs(alarmDelay() - (22 * 60 + 55) * 60 * 1000L) < 1000)
  }

  @Test fun nativeReceiptRequiresCurrentOwnerLeaseAndCountedPositiveSequence() {
    val lease = Engine.acquire(context, owner)
    reconcile(lease, todayPlan())
    assertFalse(Engine.acknowledge(context, owner, lease, 0))
    assertFalse(Engine.acknowledge(context, owner, lease, 1))
    advanceAnchor("2026-10-21T08:00:00Z")
    Engine.repair(context, Engine.RepairReason.ALARM)
    assertFalse(Engine.acknowledge(context, owner, "wrong-lease", 1))
    assertFalse(Engine.acknowledge(context, "bbbbbbbb-2222-4222-8222-222222222222", lease, 1))
    assertFalse(Engine.acknowledge(context, owner, lease, 2))
    assertTrue(Engine.acknowledge(context, owner, lease, 1))
    Engine.cancelAll(context)
    assertFalse(Engine.acknowledge(context, owner, lease, 1))
  }

  @Test fun productSuppressionSurvivesDiskReloadAndOldAccountCannotSuppressNewOne() {
    val lease = Engine.acquire(context, owner)
    reconcile(lease, todayPlan())
    Engine.suppress(context, lease, owner, "2026-10-21")
    Engine.repair(context)
    assertTrue(kotlin.math.abs(alarmDelay() - 32 * 60 * 60 * 1000L) < 1000)
    val next = Engine.acquire(context, "bbbbbbbb-2222-4222-8222-222222222222")
    assertEquals("stale_lease", Engine.suppress(context, lease, owner, null)["status"])
    assertEquals(next, saved().getString("lease"))
    Engine.cancelAll(context) // process bootstrap has no in-memory lease
    assertEquals("cancelled", Engine.repair(context)["status"])
    assertNull(notification())
  }

}


/** Fault only the real adapter's disk/OS boundaries; planner, serialization and coordinator stay production code. */
@Implements(AtomicFile::class)
class FailingAtomicFile {
  @RealObject private lateinit var actual: AtomicFile
  companion object {
    var writesBeforeFailure = -1
    var silentCommitFailure = false
  }
  @Implementation fun startWrite(): FileOutputStream {
    if (actual.baseFile.name == "local-reminders-v1.json" && writesBeforeFailure >= 0) {
      if (writesBeforeFailure-- == 0) throw IOException("injected atomic persistence failure")
    }
    return Shadow.directlyOn(actual, AtomicFile::class.java, "startWrite")
  }
  @Implementation fun finishWrite(stream: FileOutputStream?) {
    if (actual.baseFile.name == "local-reminders-v1.json" && silentCommitFailure) {
      silentCommitFailure = false; stream?.close(); return // simulate AtomicFile logging a rename failure
    }
    Shadow.directlyOn<Any, AtomicFile>(actual, AtomicFile::class.java, "finishWrite", ClassParameter.from(FileOutputStream::class.java, stream))
  }
}
@Implements(NotificationManager::class)
class FailingNotifications : ShadowNotificationManager() {
  companion object { var fail = false; var posts = 0 }
  @Implementation override fun notify(tag: String?, id: Int, notification: Notification) {
    if (fail) throw IllegalStateException("injected presentation failure")
    posts++
    super.notify(tag, id, notification)
  }
}
