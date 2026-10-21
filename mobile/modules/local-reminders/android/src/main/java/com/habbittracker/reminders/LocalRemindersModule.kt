package com.habbittracker.reminders

import android.content.Intent
import android.os.SystemClock
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID

class LocalRemindersModule : Module() {
  private var pendingLaunch: Intent? = null
  override fun definition() = ModuleDefinition {
    Name("LocalReminders")
    Events("onLaunch")
    OnNewIntent { intent ->
      if (intent.getStringExtra("local_reminder_type") == "local_habit_reminder") {
        pendingLaunch = intent
        sendEvent("onLaunch", emptyMap<String, String>())
      }
    }
    AsyncFunction("clock") { SystemClock.elapsedRealtime().toDouble() }
    AsyncFunction("launchMetadata") {
      val intent = pendingLaunch ?: appContext.currentActivity?.intent
      pendingLaunch = null
      val owner = intent?.getStringExtra("local_reminder_owner")
      val type = intent?.getStringExtra("local_reminder_type")
      val lease = intent?.getStringExtra("local_reminder_lease")
      val sequence = intent?.getLongExtra("local_reminder_sequence", 0) ?: 0
      intent?.removeExtra("local_reminder_lease")
      intent?.removeExtra("local_reminder_sequence")
      intent?.removeExtra("local_reminder_owner")
      intent?.removeExtra("local_reminder_type")
      if (type == "local_habit_reminder" && owner != null &&
        Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}").matches(owner)) {
        Engine.acknowledge(context(), owner, lease, sequence)
        mapOf("type" to type, "owner_id" to UUID.fromString(owner).toString(), "target" to "today")
      } else null
    }
    AsyncFunction("acquire") { owner: String -> Engine.acquire(context(), owner) }
    AsyncFunction("replace") { lease: String, plan: String, started: Double -> Engine.replace(context(), lease, plan, started.toLong()) }
    AsyncFunction("cancel") { lease: String -> Engine.cancel(context(), lease) }
    AsyncFunction("status") { Engine.repair(context()) }
  }
  private fun context() = requireNotNull(appContext.reactContext).applicationContext
}
