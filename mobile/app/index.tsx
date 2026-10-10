import { Button, Text } from 'react-native';
import { Form, Loading, Message, styles } from '../components/form';
import { useSession } from '../lib/session';
export default function Startup() {
  const { status, error, session, store } = useSession();
  return <Form><Text style={styles.title}>Habit Tracker</Text>{status === 'failure' ? <><Message text={error} /><Button title="Retry" onPress={store.retry} />{session && <Button title="Sign out" onPress={store.signOut} />}</> : <><Loading /><Text>Loading your account…</Text></>}</Form>;
}
