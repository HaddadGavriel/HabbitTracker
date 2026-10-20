package com.habbittracker.reminders

import android.app.AlarmManager
import android.content.Context
import android.os.SystemClock
import android.provider.Settings
import android.app.NotificationManager
import androidx.work.testing.WorkManagerTestInitHelper
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
@Config(sdk = [33])
class AndroidAdapterTest {
  private val context: Context get() = RuntimeEnvironment.getApplication()
  private val owner = "aaaaaaaa-1111-4111-8111-111111111111"
  @Before fun setup() {
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

}
