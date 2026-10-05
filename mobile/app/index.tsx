import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import type { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { Button, Platform, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { registerDevice, runInfrastructureTest, type TestResult } from '../lib/api';
import { supabase } from '../lib/supabase';

type Stage = { label: string; value: string; ok?: boolean };

export default function InfrastructureScreen() {
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('Sign in, then register this physical device.');
  const [registered, setRegistered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [roundTrip, setRoundTrip] = useState<number | null>(null);
  const [receivedRequestId, setReceivedRequestId] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const auth = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    const notification = Notifications.addNotificationReceivedListener((item) => {
      setReceivedRequestId(String(item.request.content.data?.request_id ?? 'unknown'));
    });
    return () => { auth.data.subscription.unsubscribe(); notification.remove(); };
  }, []);

  async function authenticate(mode: 'signIn' | 'signUp') {
    setBusy(true); setMessage('Contacting Supabase Auth…');
    try {
      const response = mode === 'signIn'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
      setMessage(response.error ? `Authentication failed: ${response.error.message}` : mode === 'signUp' && !response.data.session
        ? 'Account created. Confirm the email, then sign in.' : 'Authenticated successfully.');
    } catch (error) {
      setMessage(`Authentication failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setBusy(false); }
  }

  async function registerPush() {
    if (!session) return;
    setBusy(true); setRegistered(false); setMessage('Requesting notification permission…');
    try {
      if (!Device.isDevice) throw new Error('Remote push requires a physical Android device.');
      if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('default', { name: 'Infrastructure tests', importance: Notifications.AndroidImportance.MAX });
      const existing = await Notifications.getPermissionsAsync();
      const permission = existing.status === 'granted' ? existing : await Notifications.requestPermissionsAsync();
      if (permission.status !== 'granted') throw new Error('Notification permission was not granted.');
      const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID || Constants.expoConfig?.extra?.eas?.projectId;
      if (!projectId || projectId.startsWith('REPLACE_')) throw new Error('Set a real EAS project ID before building.');
      const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
      await registerDevice(session, token);
      setRegistered(true); setMessage(`Push token registered (${token.slice(0, 24)}…).`);
    } catch (error) { setMessage(`Push registration failed: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  }

  async function runTest() {
    if (!session || !registered) return;
    const requestId = `infra_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    setBusy(true); setResult(null); setReceivedRequestId(null); setMessage('API is writing, verifying, and requesting remote push…');
    const started = Date.now();
    try {
      const response = await runInfrastructureTest(session, requestId, new Date(started).toISOString());
      setRoundTrip(Date.now() - started); setResult(response); setMessage('Backend flow succeeded. Waiting for the remote notification.');
    } catch (error) { setRoundTrip(Date.now() - started); setMessage(`Infrastructure test failed: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  }

  const stages: Stage[] = [
    { label: 'Authentication', value: session ? `Logged in (${session.user.email ?? session.user.id})` : 'Not logged in', ok: !!session },
    { label: 'Push registration', value: registered ? 'Push token persisted by FastAPI' : 'Not registered', ok: registered },
    { label: 'API', value: result ? 'FastAPI responded' : 'Not run', ok: !!result },
    { label: 'Database', value: result?.database_verified ? `Verified (${result.timings_ms.database} ms)` : 'Not verified', ok: result?.database_verified },
    { label: 'Push request', value: result?.push_requested ? `Accepted; ticket ${result.expo_ticket_id ?? 'not returned'} (${result.timings_ms.push_request} ms)` : 'Not requested', ok: result?.push_requested },
    { label: 'Phone receipt', value: receivedRequestId ? `Received ${receivedRequestId}` : 'Waiting / app was backgrounded', ok: !!receivedRequestId },
  ];

  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.container}>
    <Text style={styles.title}>Infrastructure Test</Text>
    {!session ? <View style={styles.card}>
      <TextInput style={styles.input} autoCapitalize="none" keyboardType="email-address" placeholder="Email" value={email} onChangeText={setEmail} />
      <TextInput style={styles.input} secureTextEntry placeholder="Password (6+ characters)" value={password} onChangeText={setPassword} />
      <View style={styles.row}><Button title="Sign in" disabled={busy} onPress={() => authenticate('signIn')} /><Button title="Sign up" disabled={busy} onPress={() => authenticate('signUp')} /></View>
    </View> : <View style={styles.row}><Button title="Register notifications" disabled={busy} onPress={registerPush} /><Button title="Sign out" disabled={busy} onPress={() => supabase.auth.signOut()} /></View>}
    <View style={styles.primary}><Button title="Run Infrastructure Test" disabled={busy || !session || !registered} onPress={runTest} /></View>
    <Text style={styles.message}>{message}</Text>
    {stages.map((stage) => <View style={styles.stage} key={stage.label}><Text style={styles.stageTitle}>{stage.ok ? '✓' : '○'} {stage.label}</Text><Text>{stage.value}</Text></View>)}
    {result && <View style={styles.card}><Text>Request ID: {result.request_id}</Text><Text>Client → API → Client: {roundTrip} ms</Text><Text>Backend total: {result.timings_ms.server_total} ms</Text><Text>Server received: {result.server_received_at}</Text></View>}
  </ScrollView></SafeAreaView>;
}

const styles = StyleSheet.create({ safe: { flex: 1 }, container: { padding: 20, gap: 14 }, title: { fontSize: 28, fontWeight: '700' }, card: { padding: 14, backgroundColor: '#eef1f4', borderRadius: 8, gap: 10 }, input: { backgroundColor: 'white', padding: 12, borderWidth: 1, borderColor: '#aaa', borderRadius: 6 }, row: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 }, primary: { backgroundColor: '#1769aa', padding: 8, borderRadius: 8 }, message: { fontWeight: '600' }, stage: { paddingVertical: 8, borderBottomWidth: 1, borderColor: '#ddd' }, stageTitle: { fontSize: 16, fontWeight: '600' } });
