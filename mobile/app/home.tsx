import { Link } from 'expo-router';
import { Button, Text } from 'react-native';
import { Form, styles } from '../components/form';
import { useSession } from '../lib/session';
export default function Home() {
  const { profile, session, store } = useSession();
  if (!profile) return null;
  return <Form><Text style={styles.title}>Welcome, {profile.display_name}</Text><Text>@{profile.username}</Text><Text>{session?.user.email}</Text><Text>Timezone: {profile.timezone}</Text><Link href="/my-habits" style={styles.message}>My habits</Link><Link href="/diagnostics" style={styles.message}>Infrastructure diagnostics</Link><Button title="Sign out" onPress={store.signOut} /></Form>;
}
