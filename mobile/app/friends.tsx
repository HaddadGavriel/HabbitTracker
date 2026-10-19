import { useCallback, useState, useSyncExternalStore } from 'react';
import { Link, useFocusEffect } from 'expo-router';
import { ActivityIndicator, Button, KeyboardAvoidingView, Platform, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Field, styles } from '../components/form';
import { acceptFriendRequest, listFriendRequests, listFriends, rejectFriendRequest, removeFriend, searchProfile, sendFriendRequest, type PublicProfile, type RelationshipResult } from '../lib/api';
import { FriendsStore } from '../lib/friends-store';
import { useSession } from '../lib/session';

function Identity({ profile }: { profile: PublicProfile }) {
  return <><Text style={styles.label}>{profile.display_name}</Text><Text style={styles.message}>@{profile.username}</Text></>;
}

export default function Friends() {
  const { store: sessions } = useSession();
  const [store] = useState(() => FriendsStore.forSession(sessions, {
    listFriends, listFriendRequests, searchProfile, sendFriendRequest, acceptFriendRequest, rejectFriendRequest, removeFriend,
  }));
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  useFocusEffect(useCallback(() => { store.start(); return () => store.stop(); }, [store]));
  const { friends, incoming, outgoing, hasLoaded, loading, refreshing, error, query, searchLoading,
    searchComplete, searchResult, searchError, pendingAction, actionError, notice, refreshRequired, removeConfirmation } = state;
  const disabled = !store.canMutate();
  const readBusy = loading || refreshing || !!pendingAction;
  const relationship = searchResult ? store.relationshipFor(searchResult.user_id) : null;
  const section = (title: string, rows: RelationshipResult[], empty: string, kind: 'friend' | 'incoming' | 'outgoing') => <View style={localStyles.group}>
    <Text accessibilityRole="header" style={localStyles.heading}>{title}</Text>
    {kind === 'outgoing' && <Text style={styles.message}>Waiting for a response. Outgoing requests cannot be cancelled.</Text>}
    {hasLoaded && !error && rows.length === 0 && <Text style={styles.message}>{empty}</Text>}
    {rows.map(row => <View key={row.id} style={localStyles.card}>
      <Identity profile={row.profile} />
      {kind === 'friend' && <Button title="Remove friend" accessibilityLabel={`Remove friend @${row.profile.username}`}
        onPress={() => store.requestRemove(row)} disabled={disabled} />}
      {kind === 'incoming' && <>
        <Button title="Accept" accessibilityLabel={`Accept request from @${row.profile.username}`} onPress={() => store.accept(row)} disabled={disabled} />
        <Button title="Reject" accessibilityLabel={`Reject request from @${row.profile.username}`} onPress={() => store.reject(row)} disabled={disabled} />
      </>}
    </View>)}
  </View>;

  return <KeyboardAvoidingView style={localStyles.screen} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.form}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={store.refresh} />}>
      <Text accessibilityRole="header" style={styles.title}>Friends</Text>
      <Text style={styles.message}>Find someone by their exact username. Friendship alone does not share habits. Pull down to refresh.</Text>
      <Link href="/home" style={styles.message}>Home</Link>
      {(loading || (!hasLoaded && !error)) && <ActivityIndicator accessibilityLabel="Loading friends" size="large" />}
      {error && <View style={localStyles.group}>
        <Text accessibilityLiveRegion="polite" style={styles.message}>{error}</Text>
        {hasLoaded && <Text style={styles.message}>Showing your last loaded relationships.</Text>}
        <Button title="Retry loading" onPress={store.refresh} disabled={readBusy} />
      </View>}
      <View style={localStyles.group}>
        <Field label="Exact username" value={query} onChangeText={store.setQuery} autoCapitalize="none" autoCorrect={false}
          returnKeyType="search" onSubmitEditing={store.search} />
        <Text style={styles.message}>3–30 letters, digits, or underscores. Spaces at the ends and letter case are normalized.</Text>
        <Button title={searchLoading ? 'Searching…' : 'Search'} onPress={store.search} disabled={searchLoading || !query.trim()} />
        {searchLoading && <ActivityIndicator accessibilityLabel="Searching for username" />}
        {searchError && <Text accessibilityLiveRegion="polite" style={styles.message}>{searchError}</Text>}
        {searchComplete && !searchLoading && !searchError && !searchResult && <Text accessibilityLiveRegion="polite" style={styles.message}>No other profile has that username.</Text>}
        {searchResult && <View style={localStyles.card}>
          <Identity profile={searchResult} />
          {relationship === 'friend' ? <Text style={styles.message}>You are already friends.</Text>
            : relationship === 'incoming' ? <Text style={styles.message}>This person sent you a request. Accept or reject it below.</Text>
              : relationship === 'outgoing' ? <Text style={styles.message}>Your request is awaiting a response.</Text>
                : <Button title="Send request" accessibilityLabel={`Send request to @${searchResult.username}`}
                  onPress={() => store.send(searchResult)} disabled={disabled} />}
        </View>}
      </View>
      {pendingAction && <ActivityIndicator accessibilityLabel="Updating friendship" />}
      {notice && <Text accessibilityLiveRegion="polite" style={styles.message}>{notice}</Text>}
      {actionError && <Text accessibilityLiveRegion="polite" style={styles.message}>{actionError}</Text>}
      {refreshRequired && <Button title="Refresh current server state" onPress={store.refresh} disabled={readBusy} />}
      {removeConfirmation && <View style={localStyles.confirmation}>
        <Text accessibilityLiveRegion="polite" style={styles.message}>Remove {removeConfirmation.profile.display_name} (@{removeConfirmation.profile.username}) as a friend? This removes habit sharing in both directions. Becoming friends again does not restore those sharing grants.</Text>
        <Button title="Confirm removal" color="#a52a2a" onPress={() => store.confirmRemove(removeConfirmation)} disabled={disabled} />
        <Button title="Cancel removal" onPress={() => store.cancelRemove(removeConfirmation)} />
      </View>}
      {section('Accepted friends', friends, 'No friends yet. Search for an exact username to send a request.', 'friend')}
      {section('Incoming requests', incoming, 'No incoming requests.', 'incoming')}
      {section('Outgoing requests', outgoing, 'No outgoing requests.', 'outgoing')}
    </ScrollView>
  </KeyboardAvoidingView>;
}

const localStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f7f9fc' },
  group: { gap: 12 },
  heading: { fontSize: 20, fontWeight: '600', color: '#172b4d' },
  card: { padding: 16, gap: 8, borderRadius: 8, backgroundColor: 'white' },
  confirmation: { padding: 16, gap: 12, borderWidth: 1, borderColor: '#a52a2a', borderRadius: 8 },
});
