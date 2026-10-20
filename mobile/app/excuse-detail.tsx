import { useCallback, useState, useSyncExternalStore } from 'react';
import { Link, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, AppState, Button, RefreshControl, ScrollView, Text } from 'react-native';
import { Form, Message, styles } from '../components/form';
import { ExcuseView } from '../components/excuse-view';
import { readExcuse } from '../lib/api';
import { ExcuseDetailStore } from '../lib/excuse-detail-store';
import { useSession } from '../lib/session';

export default function ExcuseDetail() {
  const { occurrenceId } = useLocalSearchParams<{ occurrenceId?: string | string[] }>();
  if (typeof occurrenceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(occurrenceId)) {
    return <Form><Message text="This excuse link is invalid." /><Link href="/home" style={styles.message}>Home</Link></Form>;
  }
  return <Detail key={occurrenceId.toLowerCase()} occurrenceId={occurrenceId.toLowerCase()} />;
}
function Detail({ occurrenceId }: { occurrenceId: string }) {
  const { store: sessions } = useSession();
  const [store] = useState(() => new ExcuseDetailStore(sessions, { readExcuse }, occurrenceId));
  const { excuse, loading, error } = useSyncExternalStore(store.subscribe, store.snapshot);
  useFocusEffect(useCallback(() => {
    if (AppState.currentState !== 'background' && AppState.currentState !== 'inactive') store.start();
    const subscription = AppState.addEventListener('change', next => { if (next === 'active') store.start(); else store.stop(); });
    return () => { subscription.remove(); store.stop(); };
  }, [store]));
  return <ScrollView contentContainerStyle={styles.form}
    refreshControl={<RefreshControl refreshing={loading} onRefresh={store.refresh} />}>
    <Text accessibilityRole="header" style={styles.title}>Excuse details</Text>
    <Link href="/home" style={styles.message}>Home</Link>
    <Button title="Refresh excuse" onPress={store.refresh} disabled={loading} />
    {loading && <ActivityIndicator accessibilityLabel="Loading excuse" />}
    {error && <Text accessibilityLiveRegion="polite" style={styles.message}>{error}</Text>}
    {excuse && <>
      <ExcuseView excuse={excuse} occurrence={excuse.occurrence} />
      {excuse.status === 'pending' && excuse.owner_id !== sessions.snapshot().session?.user.id && <Link href="/pending-excuses" style={styles.message}>Review pending decisions</Link>}
    </>}
  </ScrollView>;
}
