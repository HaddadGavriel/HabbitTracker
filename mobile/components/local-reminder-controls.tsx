import { Button } from './ui';
import { useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
import { localReminderService } from '../lib/local-reminder-runtime';

export function LocalReminderControls() {
  const state = useSyncExternalStore(localReminderService.subscribe, localReminderService.snapshot);
  return <View style={{ gap: 12 }}>
    <Text style={{ fontSize: 20, fontWeight: '600' }}>Habit reminders on this device</Text>
    <Text>Notification permission: {state.permission === 'unknown' ? 'Not checked' : state.permission === 'granted' ? 'Allowed' : 'Blocked'}</Text>
    <Text accessibilityLiveRegion="polite">{state.message}</Text>
    {state.lastSuccess && <Text>Last successful schedule sync: {state.lastSuccess}</Text>}
    <Button title="Enable habit reminders" disabled={state.busy || state.enabled} onPress={() => void localReminderService.enable()} />
    <Button title="Retry / resync reminders" disabled={state.busy} onPress={() => void localReminderService.refresh()} />
    <Button title="Disable habit reminders" disabled={!state.enabled && state.status !== 'error'} onPress={() => void localReminderService.disable()} />
    <Text>Reminder times use your profile timezone. Same-day occurrences keep the server's saved reminder times and deadline. Completing or submitting an excuse stops that date's remaining reminders; reopening restores only times still ahead.</Text>
    <Text>Another device's changes cannot instantly cancel this device's offline notifications. Open or refresh the app when connected to sync eligibility. Android may delay or prevent delivery; permission denial does not block habit tracking.</Text>
  </View>;
}
