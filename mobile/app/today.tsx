import { useCallback, useState, useSyncExternalStore } from 'react';
import { useFocusEffect } from 'expo-router';
import { ActivityIndicator, AppState, Button, FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import { styles } from '../components/form';
import { ExcuseView } from '../components/excuse-view';
import { readExcuse, submitExcuse, readToday, setOccurrenceCompletion, setOccurrenceProgress, type OccurrenceResult } from '../lib/api';
import { trimExplanation } from '../lib/excuse-input';
import { useSession } from '../lib/session';
import { localReminderService } from '../lib/local-reminder-runtime';
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
  const [store] = useState(() => new TodayStore(sessions, readToday, setOccurrenceCompletion, setOccurrenceProgress, undefined, { readExcuse, submitExcuse }, localReminderService));
  const { today, loading, refreshing, error, completions, progressDrafts, excuses } = useSyncExternalStore(store.subscribe, store.snapshot);
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
    keyboardShouldPersistTaps="handled"
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
      const progressEditable = store.canSetProgress(item);
      const excuse = excuses[item.id];
      const excuseEligible = store.canSubmitExcuse(item);
      const excuseBusy = store.excuseBusy(item);
      const excuseNeedsRead = store.excuseNeedsRead(item);
      return <View style={localStyles.card}>
        <Text accessibilityRole="header" style={styles.label}>{item.snapshot.name}</Text>
        <Text style={styles.message}>{item.snapshot.type === 'binary' ? 'Binary' : 'Target'}</Text>
        {item.snapshot.type === 'target' && <Text style={styles.message}>
          Progress: {item.progress} / {item.snapshot.target}{item.snapshot.unit ? ` ${item.snapshot.unit}` : ''}
        </Text>}
        <Text style={styles.message}>Status: {statusLabels[item.state]}</Text>
        {item.snapshot.type === 'target' && !progressEditable && progressDrafts[item.id] !== undefined &&
          <Text style={styles.message}>Entered progress: {progressDrafts[item.id] || '(empty)'}</Text>}
        {progressEditable && <>
          <Text style={styles.label}>Total progress</Text>
          <TextInput
            accessibilityLabel={`Total progress for ${item.snapshot.name}`}
            style={styles.input}
            value={store.progressValue(item)}
            onChangeText={value => store.setProgressDraft(item, value)}
            inputMode="numeric"
            keyboardType="number-pad"
            editable={!completion?.pending && !completion?.refreshRequired}
          />
          <Text style={styles.message}>Set the total to 0 or more. You can lower it before the deadline.</Text>
          <Button
            title="Save progress"
            accessibilityLabel={`Save progress for ${item.snapshot.name}`}
            onPress={() => store.setProgress(item)}
            disabled={completion?.pending || completion?.refreshRequired}
          />
        </>}
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
        {excuseEligible && !excuse?.open && <Button title="Submit excuse" onPress={() => store.openExcuse(item)} />}
        {excuse?.open && <View style={localStyles.header}>
          <Text style={styles.label}>Explain this occurrence</Text>
          <Text style={styles.message}>Submitting permanently locks ordinary completion, undo, and progress for this occurrence, even if rejected. The explanation cannot be edited or withdrawn, and you cannot submit again.</Text>
          <Text style={styles.message}>Unshared submissions automatically approve. Shared submissions need a currently authorized friend’s decision. The server checks sharing when you submit.</Text>
          <Text style={styles.message}>Submit before the original deadline: {item.closes_at}. Your saved progress stays unchanged.</Text>
          <TextInput accessibilityLabel={`Explanation for ${item.snapshot.name}`} style={styles.input} multiline
            value={excuse.draft} onChangeText={value => store.setExplanation(item, value)} editable={excuseEligible} />
          <Text style={styles.message}>{Array.from(trimExplanation(excuse.draft)).length} / 1,000 Unicode characters after trimming</Text>
          <Button title="Submit and lock occurrence" onPress={() => store.submitExplanation(item)} disabled={!excuseEligible} />
          {!excuseEligible && !excuseBusy && !excuseNeedsRead && <Text style={styles.message}>Submission is currently unavailable. Refresh to check the server state and deadline.</Text>}
        </View>}
        {excuseBusy && <ActivityIndicator accessibilityLabel={`Submitting excuse for ${item.snapshot.name}`} />}
        {excuse?.error && <Text accessibilityLiveRegion="polite" style={styles.message}>{excuse.error}</Text>}
        {excuse?.message && <Text accessibilityLiveRegion="polite" style={styles.message}>{excuse.message}</Text>}
        {excuse?.result && <ExcuseView excuse={excuse.result} />}
        {['justification_pending', 'excused', 'missed'].includes(item.state) && !excuse?.result && !excuseBusy &&
          <Button title="View excuse" onPress={() => store.showExcuse(item)} disabled={loading || refreshing} />}
        {excuseNeedsRead && !excuseBusy && <Button title="Check submission" onPress={store.refresh} disabled={loading || refreshing} />}
      </View>;
    }}
  />;
}

const localStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f7f9fc' },
  header: { gap: 16 },
  card: { padding: 16, gap: 8, borderRadius: 8, backgroundColor: 'white' },
});
