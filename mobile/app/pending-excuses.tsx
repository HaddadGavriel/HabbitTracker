import { useCallback, useState, useSyncExternalStore } from 'react';
import { Link, useFocusEffect } from 'expo-router';
import { ActivityIndicator, AppState, Button, ScrollView, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { styles } from '../components/form';
import { ExcuseView } from '../components/excuse-view';
import { decideExcuse, listPendingExcuses, readExcuse } from '../lib/api';
import { PendingExcusesStore } from '../lib/pending-excuses-store';
import { useSession } from '../lib/session';

export default function PendingExcuses() {
  const { store: sessions } = useSession();
  const [store] = useState(() => PendingExcusesStore.forSession(sessions, { decideExcuse, listPendingExcuses, readExcuse }));
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  useFocusEffect(useCallback(() => {
    if (AppState.currentState !== 'background' && AppState.currentState !== 'inactive') store.start();
    const subscription = AppState.addEventListener('change', next => { if (next === 'active') store.start(); else store.stop(); });
    return () => { subscription.remove(); store.stop(); };
  }, [store]));
  const { excuses, resolved, hasLoaded, loading, deciding, refreshRequired, error, notice, confirmation } = state;
  const disabled = !store.canDecide();
  return <ScrollView contentContainerStyle={styles.form}
    refreshControl={<RefreshControl refreshing={loading} onRefresh={store.refresh} />}>
    <Text accessibilityRole="header" style={styles.title}>Pending excuse decisions</Text>
    <Text style={styles.message}>Excuses from habits currently shared with you, including earlier dates. Decisions have no midnight deadline. The first valid approval or rejection is final.</Text>
    <Link href="/home" style={styles.message}>Home</Link>
    <Link href="/shared-habits" style={styles.message}>Friends’ habits</Link>
    <Button title="Refresh current decisions" onPress={store.refresh} disabled={loading || deciding} />
    {(loading || deciding) && <ActivityIndicator accessibilityLabel={deciding ? 'Saving decision' : 'Loading pending excuses'} />}
    {notice && <Text accessibilityLiveRegion="polite" style={styles.message}>{notice}</Text>}
    {error && <Text accessibilityLiveRegion="polite" style={styles.message}>{error}</Text>}
    {refreshRequired && <Text style={styles.message}>Current access and the stored decision must be checked before another action. Retry refreshing.</Text>}
    {resolved && <View style={localStyles.card}>
      <Text accessibilityRole="header" style={styles.label}>Current final decision</Text>
      <ExcuseView excuse={resolved} occurrence={resolved.occurrence} />
    </View>}
    {hasLoaded && !excuses.length && <Text style={styles.message}>No excuses currently need your decision. Archived habits and excuses you can no longer access are hidden.</Text>}
    {excuses.map(excuse => <View key={excuse.id} style={localStyles.card}>
      <ExcuseView excuse={excuse} occurrence={excuse.occurrence} />
      {confirmation?.excuse === excuse ? <View style={localStyles.confirmation}>
        <Text accessibilityLiveRegion="polite" style={styles.message}>
          {confirmation.decision === 'approve' ? 'Approve this excuse? The occurrence will be excused.' : 'Reject this excuse? The occurrence will be missed.'} The first valid decision is permanent and cannot be changed by you, another friend, or the owner. Stored progress is preserved.
        </Text>
        <Button title={confirmation.decision === 'approve' ? 'Confirm approval' : 'Confirm rejection'}
          onPress={() => store.confirmDecision(confirmation)} disabled={disabled} />
        <Button title="Cancel decision" onPress={() => store.cancelDecision(confirmation)} />
      </View> : <>
        <Button title="Approve excuse" accessibilityLabel={`Approve excuse for ${excuse.occurrence.snapshot.name} on ${excuse.occurrence.local_date}`}
          onPress={() => store.requestDecision(excuse, 'approve')} disabled={disabled} />
        <Button title="Reject excuse" accessibilityLabel={`Reject excuse for ${excuse.occurrence.snapshot.name} on ${excuse.occurrence.local_date}`}
          onPress={() => store.requestDecision(excuse, 'reject')} disabled={disabled} />
      </>}
    </View>)}
  </ScrollView>;
}
const localStyles = StyleSheet.create({
  card: { padding: 16, gap: 12, borderRadius: 8, backgroundColor: 'white' },
  confirmation: { padding: 12, gap: 12, borderWidth: 1, borderColor: '#a52a2a', borderRadius: 8 },
});
