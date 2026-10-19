import { StyleSheet, Text, View } from 'react-native';
import { styles } from './form';
import type { HabitSnapshot, OccurrenceState, SharedHabitResult } from '../lib/api';

const stateLabels: Record<OccurrenceState, string> = {
  in_progress: 'In progress', completed: 'Completed', missed: 'Missed',
  justification_pending: 'Excuse pending', excused: 'Excused',
};
const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function Configuration({ configuration }: { configuration: HabitSnapshot }) {
  return <>
    <Text style={styles.label}>{configuration.name}</Text>
    {configuration.description && <Text style={styles.message}>{configuration.description}</Text>}
    <Text style={styles.message}>{configuration.type === 'target'
      ? `Target: ${configuration.target}${configuration.unit ? ` ${configuration.unit}` : ''}` : 'Binary (yes/no)'}</Text>
    <Text style={styles.message}>Schedule: {configuration.schedule === 'daily' ? 'Every day'
      : configuration.weekdays.map(day => weekdays[day - 1]).join(', ')}</Text>
    <Text style={styles.message}>Saved reminder times: {configuration.reminder_times.length ? configuration.reminder_times.join(', ') : 'None'}</Text>
  </>;
}

/** All occurrence labels and values use the immutable snapshot and deadline.
 * Current configuration is shown separately and never determines today's target.
 */
export function SharedHabitView({ habit }: { habit: SharedHabitResult }) {
  const occurrence = habit.occurrence;
  return <View style={localStyles.card}>
    <Text style={styles.label}>Owner: {habit.owner.display_name}</Text>
    <Text style={styles.message}>@{habit.owner.username}</Text>
    <View style={localStyles.section}>
      <Text accessibilityRole="header" style={styles.label}>Current configuration</Text>
      <Configuration configuration={habit.configuration} />
    </View>
    <View style={localStyles.section}>
      <Text accessibilityRole="header" style={styles.label}>Owner’s today: {habit.local_date}</Text>
      <Text style={styles.message}>Owner timezone: {habit.timezone}</Text>
      <Text style={styles.message}>{habit.due_today ? 'Due today' : 'Not due today — no occurrence for the owner’s current local date.'}</Text>
      {occurrence && <>
        <Text accessibilityRole="header" style={styles.label}>Today’s occurrence: {occurrence.snapshot.name}</Text>
        {occurrence.snapshot.description && <Text style={styles.message}>{occurrence.snapshot.description}</Text>}
        <Text style={styles.message}>Today’s values use the settings saved when this occurrence was created.</Text>
        <Text style={styles.message}>{occurrence.snapshot.type === 'target'
          ? `Progress: ${occurrence.progress} / ${occurrence.snapshot.target}${occurrence.snapshot.unit ? ` ${occurrence.snapshot.unit}` : ''}`
          : `Binary: ${occurrence.completed ? 'Completed' : 'Not completed'}`}</Text>
        <Text style={styles.message}>State: {stateLabels[occurrence.state]}</Text>
        <Text style={styles.message}>Occurrence date: {occurrence.local_date} · {occurrence.timezone}</Text>
        <Text style={styles.message}>Original deadline: {occurrence.closes_at}</Text>
      </>}
    </View>
    <View style={localStyles.section}>
      <Text accessibilityRole="header" style={styles.label}>Current streak: {habit.current_streak} {habit.current_streak === 1 ? 'occurrence' : 'occurrences'}</Text>
      {habit.provisional && <Text style={styles.message}>Provisional — pending excuse decisions may change this streak.</Text>}
      <Text style={styles.message}>Calculated by the server at {habit.calculated_at}.</Text>
    </View>
    <Text style={styles.message}>Last checked with the server at {habit.server_time}.</Text>
  </View>;
}

const localStyles = StyleSheet.create({
  card: { padding: 16, gap: 8, borderRadius: 8, backgroundColor: 'white' },
  section: { gap: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#dbe3ef' },
});
