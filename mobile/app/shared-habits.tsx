import { useCallback, useState, useSyncExternalStore } from 'react';
import { Link, useFocusEffect } from 'expo-router';
import { ActivityIndicator, Button, FlatList, StyleSheet, Text, View } from 'react-native';
import { styles } from '../components/form';
import { SharedHabitView } from '../components/shared-habit-view';
import { listSharedHabits, readSharedHabit } from '../lib/api';
import { SharedHabitsStore } from '../lib/shared-habits-store';
import { useSession } from '../lib/session';

export default function SharedHabits() {
  const { store: sessions } = useSession();
  const [store] = useState(() => new SharedHabitsStore(sessions, { listSharedHabits, readSharedHabit }));
  const { habits, hasLoaded, loading, refreshing, error } = useSyncExternalStore(store.subscribe, store.snapshot);
  useFocusEffect(useCallback(() => { store.start(); return () => store.stop(); }, [store]));
  const busy = loading || refreshing;

  return <FlatList
    style={localStyles.screen}
    contentContainerStyle={styles.form}
    data={habits}
    keyExtractor={habit => habit.id}
    refreshing={refreshing}
    onRefresh={store.refresh}
    ListHeaderComponent={<View style={localStyles.section}>
      <Text accessibilityRole="header" style={styles.title}>Friends’ habits</Text>
      <Text style={styles.message}>Only habits a friend explicitly shares with you appear here. Friendship alone does not grant access. Pull down to refresh.</Text>
      <Link href="/home" style={styles.message}>Home</Link>
      <Link href="/friends" style={styles.message}>Friends</Link>
      <Button title="Refresh" onPress={store.refresh} disabled={busy} />
      {busy && <ActivityIndicator accessibilityLabel="Loading shared habits" size="large" />}
      {error && <>
        <Text accessibilityLiveRegion="polite" style={styles.message}>{error}</Text>
        <Button title="Retry loading" onPress={store.refresh} disabled={busy} />
      </>}
    </View>}
    ListEmptyComponent={hasLoaded && !busy && !error
      ? <Text style={styles.message}>No habits are currently shared with you. Your friends choose which habits to share; archived habits stay hidden.</Text> : null}
    renderItem={({ item }) => <View style={localStyles.section}>
      <SharedHabitView habit={item} />
      <Link href={{ pathname: '/shared-habit', params: { id: item.id } }} style={styles.message}
        accessibilityLabel={`View shared habit ${item.configuration.name} from @${item.owner.username}`}>View shared habit</Link>
    </View>}
  />;
}

const localStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f7f9fc' },
  section: { gap: 16 },
});
