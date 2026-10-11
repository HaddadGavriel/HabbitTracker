import { useEffect, useState, useSyncExternalStore } from 'react';
import { router } from 'expo-router';
import { Button, Keyboard, Text } from 'react-native';
import { Form, Loading, Message, styles } from '../components/form';
import { HabitFields } from '../components/habit-fields';
import { createHabit } from '../lib/api';
import { CreateHabitStore } from '../lib/create-habit-store';
import { useSession } from '../lib/session';

export default function CreateHabit() {
  const { store: sessions, profile } = useSession();
  const [store] = useState(() => new CreateHabitStore(sessions, createHabit, () => router.dismissTo('/my-habits')));
  const { draft, busy, created, error, ambiguous } = useSyncExternalStore(store.subscribe, store.snapshot);
  useEffect(() => { store.start(); return () => store.stop(); }, [store]);
  const disabled = busy || created;
  const submit = () => { Keyboard.dismiss(); void store.submit(); };

  return <Form>
    <Text accessibilityRole="header" style={styles.title}>Create habit</Text>
    <HabitFields draft={draft} onChange={store.update} disabled={disabled} timezone={profile?.timezone} />
    <Message text={error} />
    {busy && <Loading />}
    {ambiguous && <>
      <Button title="Check My habits" disabled={disabled} onPress={() => router.push('/my-habits')} />
      <Text style={styles.message}>Use Back to return to this form with your entered values.</Text>
    </>}
    <Button title={busy ? 'Saving…' : ambiguous ? 'Submit again' : 'Create habit'} disabled={disabled} onPress={submit} />
  </Form>;
}
