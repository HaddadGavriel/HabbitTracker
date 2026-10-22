import { useCallback, useState, useSyncExternalStore } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Button, Keyboard, Text } from 'react-native';
import { Form, Loading, Message, styles } from '../components/form';
import { HabitFields } from '../components/habit-fields';
import { archiveHabit, readHabit, updateHabit } from '../lib/api';
import { EditHabitStore } from '../lib/edit-habit-store';
import { useSession } from '../lib/session';
import { localReminderService } from '../lib/local-reminder-runtime';

export default function EditHabit() {
  const { id } = useLocalSearchParams<{ id?: string | string[] }>();
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return <Form><Message text="This habit link is invalid." /><Button title="Back to My habits" onPress={() => router.dismissTo('/my-habits')} /></Form>;
  }
  const habitId = id.toLowerCase();
  return <Editor key={habitId} id={habitId} />;
}

function Editor({ id }: { id: string }) {
  const { store: sessions, profile } = useSession();
  const [store] = useState(() => new EditHabitStore(sessions, { readHabit, updateHabit, archiveHabit }, id, () => router.dismissTo('/my-habits'), localReminderService));
  const { draft, loading, saving, saved, error, ambiguous, unavailable, archive } = useSyncExternalStore(store.subscribe, store.snapshot);
  useFocusEffect(useCallback(() => { store.start(); return () => store.stop(); }, [store]));
  const busy = loading || saving || saved;
  const disabled = busy || (!!archive && (archive.phase !== 'failed' || archive.ambiguous));

  return <Form>
    <Text accessibilityRole="header" style={styles.title}>Edit habit</Text>
    {(loading || (!draft && !error && !unavailable)) && <Loading />}
    {unavailable && <>
      <Message text={unavailable === 'archived' ? 'This habit is archived and cannot be edited. Open Archived in My habits to restore it.' : 'This habit was not found or is no longer available to your account.'} />
      <Button title="Back to My habits" onPress={() => router.dismissTo('/my-habits')} />
    </>}
    {draft && !unavailable && <>
      <HabitFields draft={draft} onChange={store.update} disabled={disabled} timezone={profile?.timezone} readOnlyType />
      <Text style={styles.message}>Habit type cannot be changed.</Text>
    </>}
    <Message text={error} />
    {!draft && error && !unavailable && <Button title="Retry loading" disabled={loading} onPress={store.reload} />}
    {ambiguous && draft && (!archive || (archive.phase === 'failed' && !archive.ambiguous)) && <>
      <Text style={styles.message}>Reloading replaces all unsaved edits with the configuration currently saved on the server.</Text>
      <Button title="Reload saved configuration" disabled={disabled} onPress={store.reload} />
    </>}
    {saving && <Loading />}
    {draft && !unavailable && <>
      <Button title={saving ? 'Saving…' : ambiguous ? 'Save again' : 'Save changes'} disabled={disabled}
        onPress={() => { Keyboard.dismiss(); void store.save(); }} />
      {archive?.phase === 'confirming' ? <>
        <Text accessibilityRole="header" style={styles.label}>Archive this habit?</Text>
        <Text style={styles.message}>Archiving preserves your history and does not erase already-created obligations, deadlines, or progress. You can restore this habit from Archived in My habits.</Text>
        {store.hasUnsavedEdits() && <Text style={styles.message}>You have unsaved edits. Archiving will discard these edits and keep the last saved configuration.</Text>}
        <Button title="Confirm archive" disabled={busy} onPress={() => store.confirmArchive(archive)} />
        <Button title="Cancel archive" disabled={busy} onPress={() => store.cancelArchive(archive)} />
      </> : <Button title={archive?.phase === 'pending' ? 'Archiving…' : archive?.phase === 'failed' ? 'Archive again' : 'Archive habit'}
        disabled={busy || archive?.phase === 'pending'} onPress={() => { Keyboard.dismiss(); store.requestArchive(); }} />}
      {archive?.phase === 'pending' && <Loading />}
      <Message text={archive?.error ?? null} />
      {archive?.ambiguous && archive.phase === 'failed' && <>
        <Text style={styles.message}>Refreshing replaces unsaved edits with the current server state. If the habit is archived, editing will be closed.</Text>
        <Button title="Refresh current server state" disabled={busy} onPress={store.refreshServerState} />
      </>}
    </>}
  </Form>;
}
