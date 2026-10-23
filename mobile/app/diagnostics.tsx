import { Button } from '../components/ui';
import * as Notifications from 'expo-notifications';
import { useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';

import { runInfrastructureTest, type TestResult } from '../lib/api';
import { useSession } from '../lib/session';

import { NotificationControls, useNotifications } from '../components/notification-controls';

type Stage = { label: string; value: string; ok?: boolean };

export default function Diagnostics() {
  const { session } = useSession();
  return <InfrastructureScreen key={session?.user.id ?? 'none'} />;
}
function InfrastructureScreen() {
  const { session } = useSession();
  const alive = useRef(true);
  const submitting = useRef(false);
  const [message, setMessage] = useState('Register this physical device to test infrastructure.');
  const notifications = useNotifications();
  const registered = notifications.status === 'enabled';
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [roundTrip, setRoundTrip] = useState<number | null>(null);
  const [receivedRequestId, setReceivedRequestId] = useState<string | null>(null);

  useEffect(() => {
    const notification = Notifications.addNotificationReceivedListener((item) => {
      const data = item.request.content.data;
      if (data?.type === undefined && typeof data?.request_id === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(data.request_id)) {
        setReceivedRequestId(data.request_id);
      }
    });
    alive.current = true;
    return () => { alive.current = false; notification.remove(); };
  }, []);

  async function runTest() {
    if (!session || !registered || submitting.current) return;
    submitting.current = true;
    const requestId = `infra_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    setBusy(true); setResult(null); setReceivedRequestId(null); setMessage('API is writing, verifying, and requesting remote push…');
    const started = Date.now();
    try {
      const response = await runInfrastructureTest(session, requestId, new Date(started).toISOString());
      if (!alive.current) return;
      setRoundTrip(Date.now() - started); setResult(response); setMessage('Backend flow succeeded. Waiting for the remote notification.');
    } catch (error) { if (!alive.current) return; setRoundTrip(Date.now() - started); setMessage('Diagnostic request failed. Check your connection and server configuration.'); }
    finally { submitting.current = false; if (alive.current) setBusy(false); }
  }

  const stages: Stage[] = [
    { label: 'Authentication', value: session ? `Logged in (${session.user.email ?? session.user.id})` : 'Not logged in', ok: !!session },
    { label: 'Push registration', value: registered ? 'Push token persisted by FastAPI' : 'Not registered', ok: registered },
    { label: 'API', value: result ? 'FastAPI responded' : 'Not run', ok: !!result },
    { label: 'Database', value: result?.database_verified ? `Verified (${result.timings_ms.database} ms)` : 'Not verified', ok: result?.database_verified },
    { label: 'Push request', value: result?.push_requested ? `Accepted; ticket ${result.expo_ticket_id ?? 'not returned'} (${result.timings_ms.push_request} ms)` : 'Not requested', ok: result?.push_requested },
    { label: 'Phone receipt', value: receivedRequestId ? `Received ${receivedRequestId}` : 'Waiting / app was backgrounded', ok: !!receivedRequestId },
  ];

  return <ScrollView contentContainerStyle={styles.container}>
    <Text style={styles.title}>Diagnostics</Text>
    <NotificationControls />
    <View style={styles.primary}><Button title="Send diagnostic notification" disabled={busy || !session || !registered} onPress={() => Alert.alert('Send diagnostic notification?', 'This writes a diagnostic record and sends a real push notification to this account’s registered device.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Send', onPress: () => { void runTest(); } }])} /></View>
    <Text style={styles.message}>{message}</Text>
    {stages.map((stage) => <View style={styles.stage} key={stage.label}><Text style={styles.stageTitle}>{stage.ok ? '✓' : '○'} {stage.label}</Text><Text>{stage.value}</Text></View>)}
    {result && <View style={styles.card}><Text>Request ID: {result.request_id}</Text><Text>Client → API → Client: {roundTrip} ms</Text><Text>Backend total: {result.timings_ms.server_total} ms</Text><Text>Server received: {result.server_received_at}</Text></View>}
  </ScrollView>;
}

const styles = StyleSheet.create({ safe: { flex: 1 }, container: { padding: 20, gap: 14 }, title: { fontSize: 28, fontWeight: '700' }, card: { padding: 14, backgroundColor: '#eef1f4', borderRadius: 8, gap: 10 }, input: { backgroundColor: 'white', padding: 12, borderWidth: 1, borderColor: '#aaa', borderRadius: 6 }, row: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 }, primary: { backgroundColor: '#1769aa', padding: 8, borderRadius: 8 }, message: { fontWeight: '600' }, stage: { paddingVertical: 8, borderBottomWidth: 1, borderColor: '#ddd' }, stageTitle: { fontSize: 16, fontWeight: '600' } });
