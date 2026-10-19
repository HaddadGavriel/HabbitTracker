import { useCallback, useState, useSyncExternalStore } from 'react';
import { Link, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, AppState, Button, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Form, Message, styles } from '../components/form';
import { grantHabitShare, listFriends, listHabitShares, readHabit, revokeHabitShare } from '../lib/api';
import { SharingStore } from '../lib/sharing-store';
import { useSession } from '../lib/session';

export default function ManageSharing() {
  const { id } = useLocalSearchParams<{ id?: string | string[] }>();
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return <Form><Message text="This habit link is invalid." /><Button title="Back to My habits" onPress={() => router.dismissTo('/my-habits')} /></Form>;
  }
  return <Sharing key={id.toLowerCase()} id={id.toLowerCase()} />;
}

function Sharing({ id }: { id: string }) {
  const { store: sessions } = useSession();
  const [store] = useState(() => SharingStore.forSession(sessions, {
    readHabit, listFriends, listHabitShares, grantHabitShare, revokeHabitShare,
  }, id));
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  useFocusEffect(useCallback(() => {
    store.start();
    const subscription = AppState.addEventListener('change', value => { if (value === 'active') void store.reload(); });
    return () => { subscription.remove(); store.stop(); };
  }, [store]));
  const { habit, friends, grants, hasLoaded, loading, refreshing, unavailable, error, actionError,
    notice, pendingAction, refreshRequired } = state;
  const busy = loading || refreshing || !!pendingAction;
  const disabled = !store.canMutate();
  const lastLoaded = !!error || busy || refreshRequired;

  return <ScrollView contentContainerStyle={styles.form}
    refreshControl={<RefreshControl refreshing={refreshing} onRefresh={store.refresh} />}>
    <Text accessibilityRole="header" style={styles.title}>Manage sharing</Text>
    <Link href="/my-habits" style={styles.message}>My habits</Link>
    <Link href="/home" style={styles.message}>Home</Link>
    <Text style={styles.message}>Habits are private by default. Accepted friendship alone does not grant permission to view this habit. Choose each friend explicitly.</Text>
    <Text style={styles.message}>Archiving keeps grants, but recipients cannot view the habit while archived. Restoring makes retained grants available again while the friendship still exists.</Text>
    <Text style={styles.message}>Removing a friendship deletes its grants. Becoming friends again does not restore them; sharing again requires your explicit choice.</Text>
    {loading && <ActivityIndicator accessibilityLabel="Loading sharing" size="large" />}
    {refreshing && <ActivityIndicator accessibilityLabel="Refreshing sharing" />}
    {habit && <>
      <Text accessibilityRole="header" style={localStyles.heading}>{habit.name}</Text>
      <Text style={styles.message}>{habit.archived_at ? 'Archived — recipients cannot currently view this habit.' : 'Active habit'}</Text>
    </>}
    {error && <Text accessibilityLiveRegion="polite" style={styles.message}>{error}</Text>}
    {hasLoaded && (error || busy || refreshRequired) && <Text style={styles.message}>Showing last loaded permissions. Current access has not yet been confirmed.</Text>}
    {unavailable && <Button title="Back to My habits" onPress={() => router.dismissTo('/my-habits')} />}
    {error && !unavailable && <Button title="Retry loading" onPress={store.refresh} disabled={busy} />}
    {pendingAction && <>
      <ActivityIndicator accessibilityLabel="Updating sharing" />
      <Text accessibilityLiveRegion="polite" style={styles.message}>{pendingAction.kind === 'grant' ? 'Granting permission…' : 'Revoking permission…'}</Text>
    </>}
    {actionError && actionError !== error && <Text accessibilityLiveRegion="polite" style={styles.message}>{actionError}</Text>}
    {notice && <Text accessibilityLiveRegion="polite" style={styles.message}>{notice}</Text>}
    {refreshRequired && <Button title="Refresh current server state" onPress={store.refresh} disabled={busy} />}
    {!unavailable && <Button title="Refresh sharing" onPress={store.refresh} disabled={busy} />}
    {hasLoaded && !unavailable && <>
      <Text accessibilityRole="header" style={localStyles.heading}>Accepted friends</Text>
      {!lastLoaded && friends.length === 0 && <Text style={styles.message}>No accepted friends. Add friends before choosing who may view this habit.</Text>}
      {!lastLoaded && grants.length === 0 && <Text style={styles.message}>No sharing grants. This habit is private.</Text>}
      <Link href="/friends" style={styles.message}>Manage friendships</Link>
      {friends.map(row => {
        const shared = store.isShared(row.profile.user_id);
        return <View key={row.id} style={localStyles.card}>
          <Text style={styles.label}>{row.profile.display_name}</Text>
          <Text style={styles.message}>@{row.profile.username}</Text>
          <Text style={styles.message}>Accepted friend</Text>
          <Text style={styles.message}>{lastLoaded ? 'Last loaded: ' : ''}{shared ? habit?.archived_at ? 'Grant retained — access paused while archived' : 'Sharing grant enabled' : 'No permission to view this habit'}</Text>
          <Button title={shared ? 'Revoke access' : 'Grant access'}
            accessibilityLabel={`${shared ? 'Revoke' : 'Grant'} access for @${row.profile.username}`}
            disabled={disabled} onPress={() => shared ? store.revoke(row) : store.grant(row)} />
        </View>;
      })}
    </>}
  </ScrollView>;
}

const localStyles = StyleSheet.create({
  heading: { fontSize: 20, fontWeight: '600', color: '#172b4d' },
  card: { padding: 16, gap: 8, borderRadius: 8, backgroundColor: 'white' },
});
