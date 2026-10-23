import { Button } from './ui';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Alert, Text, View } from 'react-native';
import type { SharedHabitResult } from '../lib/api';
import { reminderEligible, reminderLabels, type ClockSample } from '../lib/reminder-rules';
import { cooldownUntil, unresolved } from '../lib/reminder-service';
import { reminderService } from '../lib/reminder-runtime';
import { useSession } from '../lib/session';
import { styles } from './form';

export function ReminderControls({ habit, observedAt }: { habit: SharedHabitResult; observedAt: ClockSample | null }) {
  const { session } = useSession();
  const state = useSyncExternalStore(reminderService.subscribe, reminderService.snapshot);
  const [, tick] = useState(0);
  const sender = session?.user.id;
  useEffect(() => {
    if (sender && observedAt) void reminderService.load(habit.id, sender, true);
  }, [habit, observedAt, sender, session]);
  useEffect(() => {
    const timer = setInterval(() => tick(value => value + 1), 1_000);
    return () => clearInterval(timer);
  }, []);
  if (!sender) return null;
  const view = state[habit.id];
  const requests = view?.requests ?? [];
  const latest = [...requests].reverse().find(unresolved);
  const retryAt = cooldownUntil(requests);
  const cooldown = !!retryAt && Date.parse(habit.server_time) < Date.parse(retryAt);
  const eligible = reminderEligible(habit, observedAt);
  const uncertain = !!latest && unresolved(latest);
  const blocked = !view?.loaded || view.busy || view.blocked;
  const newRequest = () => {
    if (uncertain && latest) {
      Alert.alert('Possible duplicate notification',
        'The earlier outcome is unknown. A notification may already have been accepted. Requesting a new reminder could send a duplicate.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Request new reminder', onPress: () => { void reminderService.send(habit.id, sender, undefined, latest.key); } },
        ]);
    } else { void reminderService.send(habit.id, sender); }
  };
  return <View style={{ gap: 8 }}>
    {(eligible || requests.length > 0) && <Text style={styles.label}>Friend reminder</Text>}
    {eligible && <Button title={requests.length ? 'Request new reminder' : 'Remind'}
      accessibilityLabel={`Remind ${habit.owner.display_name} about ${habit.configuration.name}`}
      disabled={blocked || cooldown || (uncertain && !latest?.retryAt)} onPress={newRequest} />}
    {eligible && <Text style={styles.message}>The server checks current access, progress, and the original deadline before accepting a request.</Text>}
    {requests.map((request, index) => <View key={request.key} style={{ gap: 8 }}>
      <Text accessibilityLiveRegion="polite" style={styles.message}>Request {index + 1}: {request.result ? reminderLabels[request.result.status]
        : request.status === 'cooldown' ? 'The server requires a cooldown before a new reminder.'
        : request.status === 'rejected' ? 'The server rejected this request. Refresh the habit before requesting another reminder.'
        : 'No confirmed outcome. This saved request may already have reached the server.'}</Text>
      {unresolved(request) && <Button title={index === requests.length - 1 ? 'Check same request' : `Check earlier request ${index + 1}`}
        disabled={blocked} onPress={() => { void reminderService.send(habit.id, sender, request.key); }} />}
    </View>)}
    {retryAt && <Text style={styles.message}>New request no earlier than {retryAt}. Refresh after this time to check the server clock and eligibility. Nothing is sent automatically.</Text>}
    {requests.some(unresolved) && <Text style={styles.message}>Checking reuses the saved key. It can complete the original request if it never reached the server; it never creates a replacement reminder.</Text>}
    {view?.message && <Text accessibilityLiveRegion="polite" style={styles.message}>{view.message}</Text>}
    {!view?.loaded && !view?.busy && <Button title="Reload saved requests" onPress={() => { void reminderService.load(habit.id, sender); }} />}
    {view?.blocked && <Text style={styles.message}>Pull down to refresh current access before checking saved requests.</Text>}
  </View>;
}
