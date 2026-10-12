import { useCallback, useState, useSyncExternalStore } from 'react';
import { useFocusEffect } from 'expo-router';
import { ActivityIndicator, AppState, Button, FlatList, StyleSheet, Text, View } from 'react-native';
import { styles } from '../components/form';
import { readToday, setOccurrenceCompletion, type OccurrenceResult } from '../lib/api';
import { useSession } from '../lib/session';
import { TodayStore } from '../lib/today-store';

const statusLabels: Record<OccurrenceResult['state'], string> = {
  in_progress: 'In progress',
  completed: 'Completed',
  missed: 'Missed',
  justification_pending: 'Excuse pending',
  excused: 'Excused',
};

export default function Today() {
  const { store: sessions } = useSession();
  const [store] = useState(() => new TodayStore(sessions, readToday, setOccurrenceCompletion));
  const { today, loading, refreshing, error, completions } = useSyncExternalStore(store.subscribe, store.snapshot);
  useFocusEffect(useCallback(() => {
    store.start();
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', next => {
      if (next === 'active' && previous !== 'active') void store.reload();
      previous = next;
    });
    return () => { subscription.remove(); store.stop(); };
  }, [store]));

  return <FlatList
    style={localStyles.screen}
    contentContainerStyle={styles.form}
    data={today?.occurrences ?? []}
    keyExtractor={occurrence => occurrence.id}
    refreshing={refreshing}
    onRefresh={store.refresh}
    ListHeaderComponent={<View style={localStyles.header}>
      <Text accessibilityRole="header" style={styles.title}>Today</Text>
      {today && <>
        <Text style={styles.message}>Date: {today.local_date}</Text>
        <Text style={styles.message}>Timezone: {today.timezone}</Text>
      </>}
      <Text style={styles.message}>Pull down to refresh.</Text>
      {(loading || (!today && !error)) && <ActivityIndicator accessibilityLabel="Loading Today" size="large" />}
      {error && <View style={localStyles.header}>
        <Text accessibilityLiveRegion="polite" style={styles.message}>{error}</Text>
        {today && <Text style={styles.message}>Showing the last loaded date and habits.</Text>}
        <Button title="Retry loading" onPress={store.refresh} disabled={loading || refreshing} />
      </View>}
    </View>}
    ListEmptyComponent={today && !error ? <Text style={styles.message}>No habits to show for this date.</Text> : null}
    renderItem={({ item }) => {
      const action = store.completionAction(item);
      const completion = completions[item.id];
      return <View style={localStyles.card}>
        <Text accessibilityRole="header" style={styles.label}>{item.snapshot.name}</Text>
        <Text style={styles.message}>{item.snapshot.type === 'binary' ? 'Binary' : 'Target'}</Text>
        {item.snapshot.type === 'target' && <Text style={styles.message}>
          Progress: {item.progress} / {item.snapshot.target}{item.snapshot.unit ? ` ${item.snapshot.unit}` : ''}
        </Text>}
        <Text style={styles.message}>Status: {statusLabels[item.state]}</Text>
        {action !== null && <Button
          title={action ? 'Complete' : 'Undo'}
          accessibilityLabel={`${action ? 'Complete' : 'Undo'} ${item.snapshot.name}`}
          onPress={() => store.setCompletion(item, action)}
          disabled={completion?.pending || completion?.refreshRequired}
        />}
        {completion?.pending && <ActivityIndicator accessibilityLabel={`Updating ${item.snapshot.name}`} />}
        {completion?.error && <Text accessibilityLiveRegion="polite" style={styles.message}>{completion.error}</Text>}
        {completion?.refreshRequired && <Button
          title="Refresh Today"
          onPress={store.refresh}
          disabled={loading || refreshing}
        />}
      </View>;
    }}
  />;
}

const localStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f7f9fc' },
  header: { gap: 16 },
  card: { padding: 16, gap: 8, borderRadius: 8, backgroundColor: 'white' },
});
