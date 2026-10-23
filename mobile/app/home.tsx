import { Link } from '../components/ui';
import { Text } from 'react-native';
import { Form, styles } from '../components/form';
import { useSession } from '../lib/session';
export default function Home() {
  const { profile } = useSession();
  if (!profile) return null;
  return <Form><Text accessibilityRole="header" style={styles.title}>Habit Tracker</Text>
    <Text style={styles.message}>{profile.display_name} · @{profile.username}</Text>
    <Link href="/today">Today</Link>
    <Link href="/my-habits">My habits</Link>
    <Link href="/friends">Friends</Link>
    <Link href="/shared-habits">Friends’ habits</Link>
    <Link href="/pending-excuses">Pending decisions</Link>
    <Link href="/settings">Settings</Link>
    <Text style={styles.message}>An internet connection is needed to load current status and save changes. Changes are not queued offline. If a save cannot be confirmed, refresh before trying it again.</Text>
  </Form>;
}
