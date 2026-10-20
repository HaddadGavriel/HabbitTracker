import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url || !key) throw new Error('Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');

export const supabase = createClient(url, key, {
  auth: { storage: AsyncStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false, flowType: 'implicit' },
});

// Email links never replace the persisted app account.
export const createLinkAuth = () => createClient(url!, key!, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false, flowType: 'implicit', storageKey: 'habittracker-email-link' },
}).auth;
