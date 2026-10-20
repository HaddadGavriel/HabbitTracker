package com.habbittracker.reminders

import android.app.*
import android.util.AtomicFile
import java.io.File
import android.content.*
import android.os.Build
import android.os.SystemClock
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.*
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.util.UUID
import java.util.concurrent.TimeUnit

/** All entry points, receivers and workers share this process and monitor. No JS execution. */
internal object Engine {
  private const val CHANNEL = "local-habit-reminders"
  private const val WORK = "local-reminder-repair-v1"
  private fun file(c: Context) = AtomicFile(File(c.noBackupFilesDir, "local-reminders-v1.json"))
  private fun write(c: Context, value: JSONObject?) {
    val target = file(c)
    val output = target.startWrite()
    try {
      output.write((value?.toString() ?: "null").toByteArray(Charsets.UTF_8))
      output.fd.sync()
      target.finishWrite(output)
    } catch (error: Exception) { target.failWrite(output); throw error }
  }
  private fun read(c: Context): JSONObject? {
    val target = file(c)
    val text = try { target.openRead().bufferedReader().use { it.readText() } }
      catch (_: java.io.FileNotFoundException) { return null }
    return if (text == "null") null else JSONObject(text)
  }
  private fun alarm(c: Context) = c.getSystemService(AlarmManager::class.java)
  private fun intent(c: Context) = PendingIntent.getBroadcast(c, 0,
    Intent(c, ReminderReceiver::class.java).setAction("com.habbittracker.REMINDER"),
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  private fun channels(c: Context) {
    c.getSystemService(NotificationManager::class.java).createNotificationChannel(
      NotificationChannel(CHANNEL, "My habit reminders", NotificationManager.IMPORTANCE_DEFAULT).apply {
        lockscreenVisibility = Notification.VISIBILITY_PRIVATE
      })
  }
  private fun allowed(c: Context): Boolean = NotificationManagerCompat.from(c).areNotificationsEnabled() &&
    c.getSystemService(NotificationManager::class.java).getNotificationChannel(CHANNEL)?.importance != NotificationManager.IMPORTANCE_NONE
  private fun exact(c: Context) = Build.VERSION.SDK_INT < 31 || alarm(c).canScheduleExactAlarms()
  private fun worker(c: Context, awaitPersistence: Boolean = false) {
    val operation = WorkManager.getInstance(c).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP,
      PeriodicWorkRequestBuilder<ReminderRepairWorker>(15, TimeUnit.MINUTES).build())
    if (awaitPersistence) operation.result.get(10, TimeUnit.SECONDS)
  }
  @Synchronized fun acquire(c: Context, owner: String): String {
    val id = UUID.fromString(owner).toString()
    val old = read(c)
    if (old?.getString("owner") == id) { worker(c, true); return old.getString("lease") }
    val lease = UUID.randomUUID().toString()
    // Persist ownership before cancelling so stale alarm callbacks cannot show old content.
    write(c, JSONObject().put("owner", id).put("lease", lease).put("plan", JSONObject.NULL)
      .put("cursor", Instant.EPOCH.toString()))
    alarm(c).cancel(intent(c))
    c.getSystemService(NotificationManager::class.java).cancel("local-reminders", 1)
    worker(c, true)
    return lease
  }
  private fun rules(s: JSONObject): List<Planner.Rule> {
    if (s.isNull("plan")) return emptyList()
    val p = s.getJSONObject("plan")
    require(p.getInt("version") == 1 && p.getString("owner_id") == s.getString("owner"))
    val owner = s.getString("owner")
    val result = mutableListOf<Planner.Rule>()
    val effective = p.getJSONArray("effective")
    for (i in 0 until effective.length()) {
      val r = effective.getJSONObject(i); val d = r.getString("local_date")
      val times = r.getJSONArray("reminder_times")
      require(times.length() > 0 && (0 until times.length()).map { times.getString(it) }.toSet().size == times.length())
      for (j in 0 until times.length()) result.add(Planner.Rule(owner, r.getString("habit_id"),
        r.getString("timezone"), d, d, r.getString("closes_at"), emptySet(), times.getString(j)))
    }
    val future = p.getJSONArray("future")
    for (i in 0 until future.length()) {
      val r = future.getJSONObject(i); val days = r.getJSONArray("weekdays")
      require((0 until days.length()).all { days.get(it) is Int })
      val weekdays = (0 until days.length()).map { days.getInt(it) }.toSet()
      require(weekdays.size == days.length())
      require((r.getString("schedule") == "daily" && weekdays.isEmpty()) ||
        (r.getString("schedule") == "selected" && weekdays.isNotEmpty()))
      require(LocalDate.parse(r.getString("eligible_from")).isAfter(LocalDate.parse(p.getString("local_date"))))
      val times = r.getJSONArray("reminder_times"); require(times.length() > 0 && (0 until times.length()).map { times.getString(it) }.toSet().size == times.length())
      for (j in 0 until times.length()) result.add(Planner.Rule(owner, r.getString("habit_id"),
        p.getString("timezone"), r.getString("eligible_from"), null, null, weekdays, times.getString(j)))
    }
    return result
  }
  private fun boot(c: Context) = Settings.Global.getInt(c.contentResolver, Settings.Global.BOOT_COUNT, -1)
  private fun now(c: Context): Instant {
    val s = read(c) ?: return Instant.now()
    if (!s.has("anchor")) return Instant.now()
    val delta = if (s.getInt("boot") == boot(c)) SystemClock.elapsedRealtime() - s.getLong("elapsed")
      else System.currentTimeMillis() - s.getLong("wall")
    return Instant.parse(s.getString("anchor")).plusMillis(maxOf(0L, delta))
  }
  private fun port(c: Context, onInexact: () -> Unit = {}) = object : Journal.Port {
    override fun load(): Journal.State? = read(c)?.let {
      Journal.State(it.getString("lease"), rules(it), Instant.parse(it.getString("cursor")))
    }
    override fun save(state: Journal.State) {
      val s = requireNotNull(read(c)); check(s.getString("lease") == state.lease)
      write(c, s.put("cursor", state.cursor.toString()))
    }
    override fun arm(time: Instant) {
      if (exact(c)) {
        try { alarm(c).setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, (System.currentTimeMillis() + maxOf(0L, time.toEpochMilli() - now(c).toEpochMilli())), intent(c)); return }
        catch (_: SecurityException) { /* permission can be revoked between check and scheduling */ }
      }
      onInexact()
      alarm(c).setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, (System.currentTimeMillis() + maxOf(0L, time.toEpochMilli() - now(c).toEpochMilli())), intent(c))
    }
    override fun cancel() { alarm(c).cancel(intent(c)) }
    override fun present(events: List<Planner.Event>) {
      check(allowed(c)) { "notifications blocked" }
      // One aggregate notification avoids Android's active-notification capacity limit.
      // Full batch is represented by a count, with a validated owner-bound Today target.
      val owner = events.first().rule.owner
      val state = requireNotNull(read(c))
      val batch = events.first().instant.toString()
      if (state.optString("countedBatch") != batch) {
        state.put("unreadCount", state.optLong("unreadCount", 0) + events.size)
        state.put("countedBatch", batch)
        write(c, state) // preserve the entire batch even if posting fails
      }
      val count = state.getLong("unreadCount")
      val launch = requireNotNull(c.packageManager.getLaunchIntentForPackage(c.packageName))
      launch.putExtra("local_reminder_type", "local_habit_reminder")
      launch.putExtra("local_reminder_owner", UUID.fromString(owner).toString())
      val tap = PendingIntent.getActivity(c, 231, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      val notification = NotificationCompat.Builder(c, CHANNEL)
        .setSmallIcon(c.applicationInfo.icon).setContentTitle("Habit Tracker")
        .setContentText("${count} habit reminder(s) since your last notification tap. Open Today.")
        .setContentIntent(tap).setAutoCancel(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build()
      c.getSystemService(NotificationManager::class.java).notify("local-reminders", 1, notification)
    }
  }
  @Synchronized fun replace(c: Context, lease: String, plan: String, started: Long): Map<String, Any> {
    val s = requireNotNull(read(c)); check(s.getString("lease") == lease) { "stale lease" }
    val p = JSONObject(plan)
    if (!s.isNull("plan") && Instant.parse(p.getString("server_time")) <
      Instant.parse(s.getJSONObject("plan").getString("server_time"))) return repair(c)
    val candidate = JSONObject(s.toString()).put("plan", p)
    rules(candidate) // validate the complete replacement before any persistence
    val elapsed = SystemClock.elapsedRealtime()
    require(started >= 0 && started <= elapsed && elapsed - started <= 120_000) { "stale clock sample" }
    // Server time is a lower bound at receipt. Do not fire early or skip an
    // imminent reminder by guessing an unobservable one-way network delay.
    val serverNow = Instant.parse(p.getString("server_time"))
    candidate.put("anchor", serverNow.toString()).put("elapsed", elapsed)
      .put("wall", System.currentTimeMillis()).put("boot", boot(c))
      .put("clockUncertaintyMs", elapsed - started)
    val cursor = Instant.parse(s.getString("cursor"))
    candidate.put("cursor", maxOf(serverNow, cursor).toString())
    write(c, candidate) // write-ahead: repair can finish even if arming fails
    return repair(c)
  }
  @Synchronized fun acknowledge(c: Context, owner: String) {
    val state = read(c) ?: return
    if (state.getString("owner") == owner) {
      val acknowledged = state.optString("countedBatch")
      if (acknowledged.isNotEmpty()) {
        state.put("cursor", maxOf(Instant.parse(state.getString("cursor")), Instant.parse(acknowledged)).toString())
      }
      write(c, state.put("unreadCount", 0))
    }
  }
  @Synchronized fun cancel(c: Context, lease: String): Map<String, Any> {
    val s = read(c)
    if (s != null && s.getString("lease") != lease) return mapOf("status" to "stale_lease")
    write(c, null)
    alarm(c).cancel(intent(c))
    WorkManager.getInstance(c).cancelUniqueWork(WORK).result.get(10, TimeUnit.SECONDS)
    c.getSystemService(NotificationManager::class.java).cancel("local-reminders", 1)
    return mapOf("status" to "cancelled")
  }
  @Synchronized fun repair(c: Context): Map<String, Any> {
    return try {
      channels(c)
      if (read(c) == null) { alarm(c).cancel(intent(c)); return mapOf("status" to "cancelled") }
      worker(c)
      if (!allowed(c)) {
        alarm(c).cancel(intent(c)); return mapOf("status" to "permission_blocked")
      }
      var usedInexact = false
      val caughtUp = Journal(port(c) { usedInexact = true }).tick(now(c))
      val state = requireNotNull(read(c))
      if (!caughtUp) return mapOf("status" to "catchup_pending")
      if (state.isNull("plan")) return mapOf("status" to "awaiting_plan")
      if (port(c).load()?.pending?.isEmpty() != false) return mapOf("status" to "idle")
      if (state.getInt("boot") != boot(c)) return mapOf("status" to "clock_unverified", "idleQuotaApplies" to true)
      mapOf("status" to if (!usedInexact && exact(c)) "scheduled_os_limited" else "inexact", "idleQuotaApplies" to true,
        "clockUncertaintyMs" to state.getLong("clockUncertaintyMs"))
    } catch (_: Exception) { mapOf("status" to "repair_required") }
  }
}

class ReminderReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val result = goAsync()
    val wake = context.getSystemService(PowerManager::class.java)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "HabitTracker:Reminder")
    wake.acquire(9_000L)
    Thread {
      try { Engine.repair(context.applicationContext) }
      finally { if (wake.isHeld) wake.release(); result.finish() }
    }.start()
  }
}
class ReminderRepairWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
  override fun doWork(): Result = if (Engine.repair(applicationContext)["status"] in listOf("repair_required", "catchup_pending")) Result.retry() else Result.success()
}
