import { Text, View } from 'react-native';
import type { HistoryExcuse, OccurrenceResult } from '../lib/api';
import { styles } from './form';

export function ExcuseView({ excuse, occurrence }: { excuse: HistoryExcuse; occurrence?: OccurrenceResult }) {
  return <View style={{ gap: 8 }}>
    {occurrence && <>
      <Text accessibilityRole="header" style={styles.label}>{occurrence.snapshot.name} · {occurrence.local_date}</Text>
      <Text style={styles.message}>Timezone: {occurrence.timezone}</Text>
      <Text style={styles.message}>Original deadline: {occurrence.closes_at}</Text>
      <Text style={styles.message}>{occurrence.snapshot.type === 'target'
        ? `Progress: ${occurrence.progress} / ${occurrence.snapshot.target}${occurrence.snapshot.unit ? ` ${occurrence.snapshot.unit}` : ''}`
        : `Binary: ${occurrence.completed ? 'Completed' : 'Not completed'}`}</Text>
      <Text style={styles.message}>Occurrence state: {occurrence.state}</Text>
    </>}
    <Text style={styles.label}>Excuse: {excuse.status}</Text>
    <Text style={styles.message}>{excuse.explanation}</Text>
    <Text style={styles.message}>Submitted: {excuse.created_at}</Text>
    <Text style={styles.message}>Decision: {excuse.decision_source === 'deleted_friend' ? 'Deleted friend' : excuse.decision_source === 'automatic' ? 'Automatic' : excuse.decision_source === 'friend' ? 'Friend' : 'Awaiting an authorized friend'}</Text>
    {excuse.decided_by && <Text style={styles.message}>Decided by: {excuse.decided_by}</Text>}
    {excuse.decided_at && <Text style={styles.message}>Decided at: {excuse.decided_at}</Text>}
    {excuse.status === 'pending' && <Text style={styles.message}>Pending stays unresolved if no authorized friends remain. Archived habits must be restored before a friend can decide.</Text>}
  </View>;
}
