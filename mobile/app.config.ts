import type { ConfigContext, ExpoConfig } from "expo/config";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Habit Tracker",
  slug: "habit-tracker-infrastructure-proof",
  version: "0.1.0",
  orientation: "portrait",
  userInterfaceStyle: "light",
  scheme: "habittrackerinfra",
  plugins: ["expo-router", ["expo-notifications", { defaultChannel: "friend-reminders" }]],
  android: {
    package: "com.haddadgavriel.habittracker",
    softwareKeyboardLayoutMode: "resize",
    // Auth sessions and deletion/notification journals must not move via OS backups.
    allowBackup: false,
    // EAS file variables resolve to a temporary path on the remote builder.
    // The fallback supports a gitignored file during local native builds.
    googleServicesFile:
      process.env.GOOGLE_SERVICES_JSON ?? "./google-services.json",
    permissions: ["POST_NOTIFICATIONS"],
  },
  extra: {
    router: { origin: false },
    eas: { projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID ?? "4f31560d-6323-41f7-ae0a-f792a4814c98" },
  },
});
