import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { readHabit, readHabitHistory, readToday } from './api';
import { NotificationTaps } from './notification-taps';
const key = 'handled-notification-taps-v1';
export const notificationTaps = new NotificationTaps({
  async loadHandled() { const value = await AsyncStorage.getItem(key); return value === null ? null : JSON.parse(value); },
  saveHandled: keys => AsyncStorage.setItem(key, JSON.stringify(keys)),
  readHabit, readHabitHistory, readToday,
  navigate: destination => router.replace(destination),
});
