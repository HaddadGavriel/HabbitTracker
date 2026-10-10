import { useEffect, useState, useSyncExternalStore } from 'react';
import { router } from 'expo-router';
import { Button, Keyboard, Pressable, StyleSheet, Text, View } from 'react-native';
import { Field, Form, Loading, Message, styles } from '../components/form';
import { createHabit } from '../lib/api';
import { CreateHabitStore } from '../lib/create-habit-store';
import { useSession } from '../lib/session';

const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
function Choice({ label, selected, disabled, onPress, checkbox = false }: {
  label: string; selected: boolean; disabled: boolean; onPress: () => void; checkbox?: boolean;
}) {
  return <Pressable accessibilityRole={checkbox ? 'checkbox' : 'radio'} accessibilityLabel={label}
    accessibilityState={{ checked: selected, disabled }} disabled={disabled} onPress={onPress}
    style={[localStyles.choice, selected && localStyles.selected, disabled && localStyles.disabled]}>
    <Text style={styles.message}>{selected ? '✓ ' : ''}{label}</Text>
  </Pressable>;
}

export default function CreateHabit() {
  const { store: sessions, profile } = useSession();
  const [store] = useState(() => new CreateHabitStore(sessions, createHabit, () => router.dismissTo('/my-habits')));
  const { draft, busy, created, error, ambiguous } = useSyncExternalStore(store.subscribe, store.snapshot);
  useEffect(() => { store.start(); return () => store.stop(); }, [store]);
  const disabled = busy || created;
  const submit = () => { Keyboard.dismiss(); void store.submit(); };

  return <Form>
    <Text accessibilityRole="header" style={styles.title}>Create habit</Text>
    <Field label="Name" value={draft.name} onChangeText={name => store.update({ name })} editable={!disabled} />
    <Field label="Description (optional)" value={draft.description} onChangeText={description => store.update({ description })} editable={!disabled} multiline />
    <Text style={styles.label}>Type</Text>
    <View style={localStyles.choices}>
      <Choice label="Binary (yes/no)" selected={draft.type === 'binary'} disabled={disabled} onPress={() => store.update({ type: 'binary' })} />
      <Choice label="Target" selected={draft.type === 'target'} disabled={disabled} onPress={() => store.update({ type: 'target' })} />
    </View>
    {draft.type === 'target' && <>
      <Field label="Target (positive whole number)" value={draft.target} onChangeText={target => store.update({ target })} editable={!disabled} keyboardType="number-pad" />
      <Field label="Unit (optional)" value={draft.unit} onChangeText={unit => store.update({ unit })} editable={!disabled} placeholder="pages, steps, glasses…" />
    </>}
    <Text style={styles.label}>Schedule</Text>
    <View style={localStyles.choices}>
      <Choice label="Every day" selected={draft.schedule === 'daily'} disabled={disabled} onPress={() => store.update({ schedule: 'daily' })} />
      <Choice label="Selected weekdays" selected={draft.schedule === 'selected'} disabled={disabled} onPress={() => store.update({ schedule: 'selected', weekdays: [] })} />
    </View>
    {draft.schedule === 'selected' && <View style={localStyles.choices}>
      {days.map((label, index) => {
        const day = index + 1;
        const selected = draft.weekdays.includes(day);
        return <Choice key={day} label={label} checkbox selected={selected} disabled={disabled}
          onPress={() => store.update({ weekdays: selected ? draft.weekdays.filter(value => value !== day) : [...draft.weekdays, day] })} />;
      })}
    </View>}
    <Field label="Reminder times (HH:MM, separated by commas)" value={draft.reminderTimes} onChangeText={reminderTimes => store.update({ reminderTimes })}
      editable={!disabled} autoCapitalize="none" autoCorrect={false} placeholder="08:00, 21:30" />
    <Text style={styles.message}>Enter at least one distinct time in 24-hour format. Times use your profile timezone ({profile?.timezone}). These are saved settings; notification scheduling is not implemented yet.</Text>
    <Message text={error} />
    {busy && <Loading />}
    {ambiguous && <>
      <Button title="Check My habits" disabled={disabled} onPress={() => router.push('/my-habits')} />
      <Text style={styles.message}>Use Back to return to this form with your entered values.</Text>
    </>}
    <Button title={busy ? 'Saving…' : ambiguous ? 'Submit again' : 'Create habit'} disabled={disabled} onPress={submit} />
  </Form>;
}

const localStyles = StyleSheet.create({
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: { minHeight: 48, padding: 12, borderWidth: 1, borderColor: '#68778d', borderRadius: 8, backgroundColor: 'white' },
  selected: { backgroundColor: '#e8f0fe', borderColor: '#172b4d' },
  disabled: { opacity: 0.6 },
});
