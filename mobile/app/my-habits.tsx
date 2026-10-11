import { useCallback, useState, useSyncExternalStore } from 'react';
import { Link, useFocusEffect } from 'expo-router';
import { ActivityIndicator, Button, FlatList, StyleSheet, Text, View } from 'react-native';
import { styles } from '../components/form';
import { listHabits } from '../lib/api';
import { habitSchedule, habitType } from '../lib/habit-labels';
import { HabitsStore } from '../lib/habits-store';
import { useSession } from '../lib/session';

export default function MyHabits() {
  const { store: sessions } = useSession();
  const [store] = useState(() => new HabitsStore(sessions, listHabits));
  const { habits, hasLoaded, loading, refreshing, error } = useSyncExternalStore(store.subscribe, store.snapshot);
  // Returning from creation (or checking an uncertain save) reads the current list.
  useFocusEffect(useCallback(() => { store.start(); return () => store.stop(); }, [store]));

  return <FlatList
    style={localStyles.screen}
    contentContainerStyle={styles.form}
    data={habits}
    keyExtractor={habit => habit.id}
    refreshing={refreshing}
    onRefresh={store.reload}
    ListHeaderComponent={<View style={localStyles.header}>
      <Text accessibilityRole="header" style={styles.title}>My habits</Text>
      <Link href="/create-habit" style={styles.message}>Create habit</Link>
      <Text style={styles.message}>Your active habits. Pull down to refresh.</Text>
      {(loading || (!hasLoaded && !error)) && <ActivityIndicator accessibilityLabel="Loading habits" size="large" />}
      {error && <View style={localStyles.header}>
        <Text accessibilityLiveRegion="polite" style={styles.message}>{error}</Text>
        {hasLoaded && <Text style={styles.message}>Showing your last loaded habits.</Text>}
        <Button title="Retry" onPress={store.reload} />
      </View>}
    </View>}
    ListEmptyComponent={hasLoaded && !error ? <Text style={styles.message}>No active habits yet.</Text> : null}
    renderItem={({ item }) => <View style={localStyles.card}>
      <Text accessibilityRole="header" style={styles.label}>{item.name}</Text>
      <Text style={styles.message}>{habitType(item)}</Text>
      <Text style={styles.message}>Schedule: {habitSchedule(item)}</Text>
    </View>}
  />;
}

const localStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f7f9fc' },
  header: { gap: 16 },
  card: { padding: 16, gap: 8, borderRadius: 8, backgroundColor: 'white' },
});
