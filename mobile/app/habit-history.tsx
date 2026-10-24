import { Button } from '../components/ui';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, AppState, FlatList, StyleSheet, Text, View } from 'react-native';
import { Form, Message, styles } from '../components/form';
import { readHabitHistory, readHabitStreak, type HistoryOccurrence, type OccurrenceState } from '../lib/api';
import { HistoryStore } from '../lib/history-store';
import { useSession } from '../lib/session';

const stateLabels: Record<OccurrenceState, string> = {
  in_progress: 'In progress', completed: 'Completed', missed: 'Missed',
  justification_pending: 'Excuse pending', excused: 'Excused',
};
const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export default function HabitHistory() {
  const { id } = useLocalSearchParams<{ id?: string | string[] }>();
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return <Form><Message text="This habit link is invalid." /><Button title="Back to My habits" onPress={() => router.dismissTo('/my-habits')} /></Form>;
  }
  const habitId = id.toLowerCase();
  return <History key={habitId} id={habitId} />;
}

function History({ id }: { id: string }) {
  const { store: sessions } = useSession();
  const [store] = useState(() => new HistoryStore(sessions, { readHabitHistory, readHabitStreak }, id));
  const { occurrences, nextCursor, hasLoaded, loading, refreshing, error, loadingMore,
    pageError, streak, streakLoading, streakError } = useSyncExternalStore(store.subscribe, store.snapshot);
  useFocusEffect(useCallback(() => {
    store.start();
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', next => {
      if (next === 'active' && previous !== 'active') void store.refreshServerState();
      previous = next;
    });
    return () => { subscription.remove(); store.stop(); };
  }, [store]));

  return <FlatList
    style={localStyles.screen}
    contentContainerStyle={styles.form}
    data={occurrences}
    keyExtractor={occurrence => occurrence.id}
    refreshing={refreshing}
    onRefresh={store.refreshServerState}
    ListHeaderComponent={<View style={localStyles.section}>
      <Text accessibilityRole="header" style={styles.title}>Habit history</Text>
      <Text style={styles.message}>Newest first, using each occurrence’s stored date and habit settings. Pull down to refresh.</Text>
      <View style={localStyles.card}>
        <Text accessibilityRole="header" style={styles.label}>Current streak</Text>
        {streakLoading && <ActivityIndicator accessibilityLabel="Loading current streak" />}
        {streak && <>
          <Text style={styles.label}>{streak.current_streak} {streak.current_streak === 1 ? 'occurrence' : 'occurrences'}</Text>
          {streak.provisional && <Text style={styles.message}>Provisional — pending excuse decisions may change this streak.</Text>}
          <Text style={styles.message}>Calculated by the server at {streak.calculated_at}.</Text>
        </>}
        {streakError && <>
          <Text accessibilityLiveRegion="polite" style={styles.message}>{streakError}</Text>
          {streak && <Text style={styles.message}>Showing the last loaded streak.</Text>}
          <Button title="Retry streak" onPress={store.retryStreak} disabled={streakLoading} />
        </>}
      </View>
      {(loading || (!hasLoaded && !error)) && <ActivityIndicator accessibilityLabel="Loading habit history" size="large" />}
      {error && <View style={localStyles.section}>
        <Text accessibilityLiveRegion="polite" style={styles.message}>{error}</Text>
        {hasLoaded && <Text style={styles.message}>Showing the last loaded history. Refresh successfully before loading older entries.</Text>}
        <Button title="Retry history" onPress={store.retryHistory} disabled={loading || refreshing} />
      </View>}
    </View>}
    ListEmptyComponent={hasLoaded && !error ? <Text style={styles.message}>No history yet for this habit.</Text> : null}
    ListFooterComponent={<View style={localStyles.section}>
      {loadingMore && <ActivityIndicator accessibilityLabel="Loading older history" />}
      {pageError && <Text accessibilityLiveRegion="polite" style={styles.message}>{pageError}</Text>}
      {nextCursor && <Button title={pageError ? 'Retry older history' : 'Load more'} onPress={store.loadMore}
        disabled={loading || refreshing || loadingMore || !!error} />}
      {hasLoaded && occurrences.length > 0 && !nextCursor && !error && !refreshing && <Text style={styles.message}>You’ve reached the end of this habit’s history.</Text>}
    </View>}
    renderItem={({ item }) => <HistoryEntry occurrence={item} />}
  />;
}

function HistoryEntry({ occurrence }: { occurrence: HistoryOccurrence }) {
  const snapshot = occurrence.snapshot;
  const excuse = occurrence.excuse;
  return <View style={localStyles.card}>
    <Text accessibilityRole="header" style={styles.label}>{occurrence.local_date} · {snapshot.name}</Text>
    <Text style={styles.message}>State: {stateLabels[occurrence.state]}</Text>
    {snapshot.description && <Text style={styles.message}>{snapshot.description}</Text>}
    <Text style={styles.message}>{snapshot.type === 'target'
      ? `Progress: ${occurrence.progress} / ${snapshot.target}${snapshot.unit ? ` ${snapshot.unit}` : ''}`
      : `Binary: ${occurrence.completed ? 'Completed' : 'Not completed'}`}</Text>
    <Text style={styles.message}>Schedule: {snapshot.schedule === 'daily' ? 'Every day' : snapshot.weekdays.map(day => weekdays[day - 1]).join(', ')}</Text>
    {snapshot.reminder_times.length > 0 && <Text style={styles.message}>Saved reminder times: {snapshot.reminder_times.join(', ')}</Text>}
    <Text style={styles.message}>Timezone: {occurrence.timezone}</Text>
    <Text style={styles.message}>Deadline: {occurrence.closes_at}</Text>
    {excuse && <View style={localStyles.excuse}>
      <Text style={styles.label}>Excuse: {excuse.status}</Text>
      <Text style={styles.message}>{excuse.explanation}</Text>
      <Text style={styles.message}>Submitted: {excuse.created_at}</Text>
      {excuse.decision_source && <Text style={styles.message}>Decision: {excuse.decision_source === 'deleted_friend' ? 'Deleted friend' : excuse.decision_source === 'automatic' ? 'Automatic' : 'Friend'}</Text>}
      {excuse.decided_by && <Text style={styles.message}>Decided by: {excuse.decided_by}</Text>}
      {excuse.decided_at && <Text style={styles.message}>Decided at: {excuse.decided_at}</Text>}
    </View>}
  </View>;
}

const localStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f7f9fc' },
  section: { gap: 16 },
  card: { padding: 16, gap: 8, borderRadius: 8, backgroundColor: 'white' },
  excuse: { gap: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#dbe3ef' },
});
