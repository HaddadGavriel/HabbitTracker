import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { readSharedHabit, requestReminder } from './api';
import { ReminderService } from './reminder-service';
const key = (sender: string, habit: string) => `friend-reminders-v1:${encodeURIComponent(sender)}:${encodeURIComponent(habit)}`;
export const reminderService = new ReminderService({
  async load(sender, habit) {
    const value = await AsyncStorage.getItem(key(sender, habit));
    return value === null ? null : JSON.parse(value);
  },
  save: (sender, habit, requests) => AsyncStorage.setItem(key(sender, habit), JSON.stringify(requests)),
  newKey: () => Crypto.randomUUID(), readSharedHabit, requestReminder,
});
