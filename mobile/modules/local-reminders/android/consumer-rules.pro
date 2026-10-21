# WorkManager persists this class name across process/app restarts and upgrades.
-keep class com.habbittracker.reminders.ReminderRepairWorker { public <init>(android.content.Context, androidx.work.WorkerParameters); }
