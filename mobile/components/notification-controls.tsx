import { useState, useSyncExternalStore } from 'react';
import { Button, Text, View } from 'react-native';
import { notificationService, openNotificationSettings } from '../lib/notification-runtime';
export function useNotifications() {
  return useSyncExternalStore(notificationService.subscribe, notificationService.snapshot);
}
export function NotificationCleanupNotice() {
  const state = useNotifications();
  if (!state.cleanupPending && !state.clearFailed) return null;
  return <View style={{ padding: 12, gap: 8 }} accessibilityLiveRegion="polite">
    {state.cleanupPending && <Text>Remote notification removal is unconfirmed. This installation may still receive notifications. Reconnect and retry cleanup. If you signed out or switched accounts, sign in to the previous account to finish cleanup. You can also block notifications in system settings.</Text>}
    {state.clearFailed && <Text>Some displayed notifications could not be cleared. Remove them from the notification tray.</Text>}
    <Button title="Retry notification cleanup" disabled={state.busy} onPress={() => void notificationService.retryCleanup()} />
  </View>;
}
export function NotificationControls() {
  const state = useNotifications();
  const [error, setError] = useState<string | null>(null);
  return <View style={{ gap: 12 }}>
    <Text style={{ fontSize: 20, fontWeight: '600' }}>Notifications</Text>
    <Text accessibilityLiveRegion="polite">{state.message}</Text>
    <Text>Enable remote reminders for this account on this installation. Habit reminder times do not schedule local notifications.</Text>
    <Text>If you used notifications in an older app version, enable once here before disabling to remove that earlier registration.</Text>
    <Button title="Enable notifications" disabled={state.busy || state.status === 'enabled'} onPress={() => void notificationService.enable()} />
    <Button title="Disable notifications" disabled={state.busy || state.status === 'signed_out'} onPress={() => void notificationService.disable()} />
    <Button title="Open system notification settings" onPress={async () => {
      try { await openNotificationSettings(); setError(null); }
      catch { setError('Open your device Settings, select Habit Tracker, then Notifications.'); }
    }} />
    {error && <Text>{error}</Text>}
  </View>;
}
