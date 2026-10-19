import { useCallback, useState, useSyncExternalStore } from 'react';
import { Link, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Button, RefreshControl, ScrollView, Text } from 'react-native';
import { Form, Message, styles } from '../components/form';
import { SharedHabitView } from '../components/shared-habit-view';
import { listSharedHabits, readSharedHabit } from '../lib/api';
import { SharedHabitsStore } from '../lib/shared-habits-store';
import { useSession } from '../lib/session';

export default function SharedHabit() {
  const { id } = useLocalSearchParams<{ id?: string | string[] }>();
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return <Form><Message text="This shared habit link is invalid." />
      <Button title="Back to Friends’ habits" onPress={() => router.dismissTo('/shared-habits')} /></Form>;
  }
  const habitId = id.toLowerCase();
  return <Detail key={habitId} id={habitId} />;
}

function Detail({ id }: { id: string }) {
  const { store: sessions } = useSession();
  const [store] = useState(() => new SharedHabitsStore(sessions, { listSharedHabits, readSharedHabit }, id));
  const { habit, loading, refreshing, error } = useSyncExternalStore(store.subscribe, store.snapshot);
  useFocusEffect(useCallback(() => { store.start(); return () => store.stop(); }, [store]));
  const busy = loading || refreshing;

  return <ScrollView contentContainerStyle={styles.form}
    refreshControl={<RefreshControl refreshing={refreshing} onRefresh={store.refresh} />}>
    <Text accessibilityRole="header" style={styles.title}>Shared habit</Text>
    <Text style={styles.message}>A view of the habit your friend chose to share. Pull down to refresh current access and progress.</Text>
    <Button title="Back to Friends’ habits" onPress={() => router.dismissTo('/shared-habits')} />
    <Link href="/home" style={styles.message}>Home</Link>
    <Button title="Refresh" onPress={store.refresh} disabled={busy} />
    {busy && <ActivityIndicator accessibilityLabel="Loading shared habit" size="large" />}
    {error && <>
      <Text accessibilityLiveRegion="polite" style={styles.message}>{error}</Text>
      <Button title="Retry loading" onPress={store.refresh} disabled={busy} />
    </>}
    {habit && <SharedHabitView habit={habit} />}
  </ScrollView>;
}
