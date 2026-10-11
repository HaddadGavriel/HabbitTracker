import { useCallback, useState, useSyncExternalStore } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Button, Keyboard, Text } from 'react-native';
import { Form, Loading, Message, styles } from '../components/form';
import { HabitFields } from '../components/habit-fields';
import { readHabit, updateHabit } from '../lib/api';
import { EditHabitStore } from '../lib/edit-habit-store';
import { useSession } from '../lib/session';

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
  const [store] = useState(() => new EditHabitStore(sessions, { readHabit, updateHabit }, id, () => router.dismissTo('/my-habits')));
  const { draft, loading, saving, saved, error, ambiguous, unavailable } = useSyncExternalStore(store.subscribe, store.snapshot);
  useFocusEffect(useCallback(() => { store.start(); return () => store.stop(); }, [store]));
  const disabled = loading || saving || saved;

  return <Form>
    <Text accessibilityRole="header" style={styles.title}>Edit habit</Text>
    {(loading || (!draft && !error && !unavailable)) && <Loading />}
    {unavailable && <>
      <Message text={unavailable === 'archived' ? 'This habit is archived and cannot be edited.' : 'This habit was not found or is no longer available to your account.'} />
      <Button title="Back to My habits" onPress={() => router.dismissTo('/my-habits')} />
    </>}
    {draft && !unavailable && <>
      <HabitFields draft={draft} onChange={store.update} disabled={disabled} timezone={profile?.timezone} readOnlyType />
      <Text style={styles.message}>Habit type cannot be changed.</Text>
    </>}
    <Message text={error} />
    {!draft && error && !unavailable && <Button title="Retry loading" disabled={loading} onPress={store.reload} />}
    {ambiguous && draft && <>
      <Text style={styles.message}>Reloading replaces all unsaved edits with the configuration currently saved on the server.</Text>
      <Button title="Reload saved configuration" disabled={disabled} onPress={store.reload} />
    </>}
    {saving && <Loading />}
    {draft && !unavailable && <Button title={saving ? 'Saving…' : ambiguous ? 'Save again' : 'Save changes'} disabled={disabled}
      onPress={() => { Keyboard.dismiss(); void store.save(); }} />}
  </Form>;
}
