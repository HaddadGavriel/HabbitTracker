import { Button } from './ui';
import { useState, useSyncExternalStore } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { notificationService, openNotificationSettings } from '../lib/notification-runtime';
import { localReminderService } from '../lib/local-reminder-runtime';
import { LocalReminderControls } from './local-reminder-controls';
export function useNotifications() {
  return useSyncExternalStore(notificationService.subscribe, notificationService.snapshot);
}
export function NotificationCleanupNotice() {
  const state = useNotifications();
  const local = useSyncExternalStore(localReminderService.subscribe, localReminderService.snapshot);
  const localCleanupFailed = local.status === 'error' && !local.enabled;
  if (!state.cleanupPending && !state.clearFailed && !localCleanupFailed) return null;
  return <SafeAreaView edges={['top']}><ScrollView style={{ maxHeight: 180 }} contentContainerStyle={{ padding: 12, gap: 8 }} accessibilityLiveRegion="polite">
    {state.cleanupPending && <Text>Remote notification removal is unconfirmed. This installation may still receive notifications. Reconnect and retry cleanup. If you signed out or switched accounts, sign in to the previous account to finish cleanup. You can also block notifications in system settings.</Text>}
    {state.clearFailed && <Text>Some displayed notifications could not be cleared. Remove them from the notification tray.</Text>}
    {(state.cleanupPending || state.clearFailed) && <Button title="Retry notification cleanup" disabled={state.busy} onPress={() => void notificationService.retryCleanup()} />}
    {localCleanupFailed && <><Text>Local reminder cleanup could not be confirmed. Retry cleanup or block Habit Tracker notifications in system settings.</Text>
      <Button title="Retry local reminder cleanup" onPress={() => void localReminderService.disable()} /></>}
  </ScrollView></SafeAreaView>;
}
export function NotificationControls() {
  const state = useNotifications();
  const [error, setError] = useState<string | null>(null);
  return <View style={{ gap: 12 }}>
    <Text style={{ fontSize: 20, fontWeight: '600' }}>Notifications</Text>
    <Text accessibilityLiveRegion="polite">{state.message}</Text>
    <Text>Enable friend reminders for this account on this installation. Configure local habit reminders separately below.</Text>
    <Text>If you used notifications in an older app version, enable once here before disabling to remove that earlier registration.</Text>
    <Button title="Enable notifications" disabled={state.busy || state.status === 'enabled'} onPress={() => void notificationService.enable()} />
    <Button title="Disable notifications" disabled={state.busy || state.status === 'signed_out'} onPress={() => {
      void localReminderService.disable(); void notificationService.disable();
    }} />
    <Button title="Open system notification settings" onPress={async () => {
      try { await openNotificationSettings(); setError(null); }
      catch { setError('Open your device Settings, select Habit Tracker, then Notifications.'); }
    }} />
    {error && <Text>{error}</Text>}
    <LocalReminderControls />
  </View>;
}
