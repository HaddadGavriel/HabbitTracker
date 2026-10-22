import { useCallback, useState, useSyncExternalStore } from 'react';
import { Link, useFocusEffect } from 'expo-router';
import { ActivityIndicator, Button, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { styles } from '../components/form';
import { listHabits, restoreHabit } from '../lib/api';
import { habitSchedule, habitType } from '../lib/habit-labels';
import { HabitsStore } from '../lib/habits-store';
import { useSession } from '../lib/session';
import { localReminderService } from '../lib/local-reminder-runtime';

export default function MyHabits() {
  const { store: sessions } = useSession();
  const [store] = useState(() => new HabitsStore(sessions, listHabits, restoreHabit, localReminderService));
  const { habits, status, hasLoaded, loading, refreshing, error,
    restoreConfirmation, restoringId, restoreError, restoreUncertain } = useSyncExternalStore(store.subscribe, store.snapshot);
  // Returning from creation/editing (or checking an uncertain save) reads the current list.
  useFocusEffect(useCallback(() => { store.start(); return () => store.stop(); }, [store]));
  const restoreDisabled = !!restoringId || loading || refreshing || restoreUncertain;

  return <FlatList
    style={localStyles.screen}
    contentContainerStyle={styles.form}
    data={habits}
    keyExtractor={habit => habit.id}
    refreshing={refreshing}
    onRefresh={store.refreshServerState}
    ListHeaderComponent={<View style={localStyles.header}>
      <Text accessibilityRole="header" style={styles.title}>My habits</Text>
      <Link href="/create-habit" style={styles.message}>Create habit</Link>
      <View style={localStyles.filters} accessibilityRole="tablist">
        {(['active', 'archived'] as const).map(filter => <Pressable key={filter}
          style={[localStyles.filter, status === filter && localStyles.selectedFilter]}
          accessibilityRole="tab" accessibilityState={{ selected: status === filter }}
          onPress={() => store.setStatus(filter)}>
          <Text style={styles.label}>{filter === 'active' ? 'Active' : 'Archived'}</Text>
        </Pressable>)}
      </View>
      <Text style={styles.message}>{status === 'active'
        ? 'Your active habits. Pull down to refresh.'
        : 'Archived habits keep their history. Restore a habit before editing it. Pull down to refresh.'}</Text>
      {(loading || (!hasLoaded && !error)) && <ActivityIndicator accessibilityLabel="Loading habits" size="large" />}
      {error && <View style={localStyles.header}>
        <Text accessibilityLiveRegion="polite" style={styles.message}>{error}</Text>
        {hasLoaded && <Text style={styles.message}>Showing your last loaded habits.</Text>}
        <Button title="Retry loading" onPress={store.refreshServerState} disabled={loading || refreshing || !!restoringId} />
      </View>}
      {restoreError && <View style={localStyles.header}>
        <Text accessibilityLiveRegion="polite" style={styles.message}>{restoreError}</Text>
        <Button title="Refresh current server state" onPress={store.refreshServerState} disabled={loading || refreshing || !!restoringId} />
      </View>}
      {restoreConfirmation && <View style={localStyles.header}>
        <Text accessibilityLiveRegion="polite" style={styles.message}>Restore “{restoreConfirmation.name}”? It will return to Active habits with its history preserved.</Text>
        <Button title="Confirm restore" onPress={() => store.confirmRestore(restoreConfirmation)} disabled={restoreDisabled} />
        <Button title="Cancel restore" onPress={() => store.cancelRestore(restoreConfirmation)} />
      </View>}
    </View>}
    ListEmptyComponent={hasLoaded && !error ? <Text style={styles.message}>{status === 'active' ? 'No active habits yet.' : 'No archived habits.'}</Text> : null}
    renderItem={({ item }) => {
      const details = <>
        <Text accessibilityRole="header" style={styles.label}>{item.name}</Text>
        <Text style={styles.message}>{habitType(item)}</Text>
        <Text style={styles.message}>Schedule: {habitSchedule(item)}</Text>
      </>;
      return <View style={localStyles.card}>
        {status === 'active'
        ? <Link href={{ pathname: '/edit-habit', params: { id: item.id } }} asChild><Pressable style={localStyles.details} accessibilityRole="button" accessibilityLabel={`Edit ${item.name}`}>
          {details}
        </Pressable></Link>
        : <>
          {details}
          {restoringId === item.id && <ActivityIndicator accessibilityLabel={`Restoring ${item.name}`} />}
          <Button title={restoringId === item.id ? 'Restoring…' : 'Restore'} accessibilityLabel={`Restore ${item.name}`}
            onPress={() => store.requestRestore(item)} disabled={restoreDisabled} />
        </>}
        <Link href={{ pathname: '/habit-history', params: { id: item.id } }} style={styles.message}
          accessibilityLabel={`View history for ${item.name}`}>View history</Link>
        <Link href={{ pathname: '/manage-sharing', params: { id: item.id } }} style={styles.message}
          accessibilityLabel={`Manage sharing for ${item.name}`}>Manage sharing</Link>
      </View>;
    }}
  />;
}

const localStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f7f9fc' },
  header: { gap: 16 },
  filters: { flexDirection: 'row', gap: 12 },
  filter: { padding: 12, borderRadius: 8, borderWidth: 1, borderColor: '#b8c4d8' },
  selectedFilter: { backgroundColor: '#dbeafe', borderColor: '#2563eb' },
  card: { padding: 16, gap: 8, borderRadius: 8, backgroundColor: 'white' },
  details: { gap: 8 },
});
