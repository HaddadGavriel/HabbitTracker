const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
const { compile, session, flush } = require('./sharing-test-support.cjs');
const { NotificationService } = compile('lib/notification-service.ts', () => ({}));

function runtime(platform = 'android') {
  const calls = []; let tokenListener, appListener, stored = null, id = 0;
  const channels = new Map();
  const native = {
    AndroidImportance: { NONE: 0, DEFAULT: 3 }, AndroidNotificationVisibility: { PRIVATE: 0 },
    IosAuthorizationStatus: { AUTHORIZED: 2, PROVISIONAL: 3, EPHEMERAL: 4, NOT_DETERMINED: 0 },
    setNotificationChannelAsync: async (id, settings) => { calls.push(['channel', id]); channels.set(id, settings); },
    getNotificationChannelAsync: async id => channels.get(id),
    getPermissionsAsync: async () => ({ granted: true, canAskAgain: true, ios: { status: 2 } }),
    requestPermissionsAsync: async () => { calls.push(['prompt']); return { granted: true }; },
    getExpoPushTokenAsync: async options => { calls.push(['expo', options]); return { data: 'ExpoPushToken[mock]' }; },
    dismissAllNotificationsAsync: async () => { calls.push(['dismiss']); },
    setBadgeCountAsync: async value => { calls.push(['badge', value]); return true; },
    clearLastNotificationResponseAsync: async () => { calls.push(['response-clear']); },
    addPushTokenListener: cb => { tokenListener = cb; return { remove: () => { tokenListener = null; } }; },
  };
  const linking = { sendIntent: async (...args) => { calls.push(['intent', ...args]); }, openSettings: async () => { calls.push(['settings']); } };
  const modules = {
    '@react-native-async-storage/async-storage': { __esModule: true, default: { getItem: async () => stored, setItem: async (_, value) => { stored = value; } } },
    'expo-constants': { __esModule: true, default: { expoConfig: { android: { package: 'com.haddadgavriel.habittracker' }, extra: { eas: { projectId: 'project-id' } } } } },
    'expo-crypto': { randomUUID: () => `id-${++id}` }, 'expo-device': { isDevice: true },
    'expo-notifications': native,
    'react-native': { Platform: { OS: platform }, Linking: linking, AppState: {
      addEventListener: (_, cb) => { appListener = cb; return { remove: () => { appListener = null; } }; },
    } },
    './api': {
      registerDevice: async (s, token, registrationId, os) => { calls.push(['register', s.user.id, token, registrationId, os]); return { registered: true, registration_id: registrationId }; },
      unregisterDevice: async (...args) => { calls.push(['unregister', ...args]); return { removed: true }; },
    },
    './notification-service': { NotificationService },
  };
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(`${__dirname}/../lib/notification-runtime.ts`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, process: { env: {} }, setTimeout, clearTimeout, require: name => {
    assert(name in modules, name); return modules[name];
  } });
  return { ...exports, native, channels, calls, linking,
    tokenEvent: () => tokenListener({ type: 'android', data: 'native-fcm-token-never-send-to-api' }),
    foreground: () => appListener('active'), listeners: () => [tokenListener, appListener] };
}

test('native runtime prepares intended channels before registration and refetches Expo token on native renewal', async () => {
  const x = runtime(), stop = x.startNotificationListeners();
  await x.notificationService.setSession(session('a')); await x.notificationService.enable();
  assert.deepEqual(x.calls.filter(c => ['channel', 'expo', 'register'].includes(c[0])).map(c => c[0]), ['channel', 'channel', 'expo', 'register']);
  assert(x.channels.has('friend-reminders')); assert(x.channels.has('infrastructure-tests'));
  x.tokenEvent(); await flush();
  assert.equal(x.calls.filter(c => c[0] === 'register').length, 2);
  assert(x.calls.filter(c => c[0] === 'register').every(c => c[2] === 'ExpoPushToken[mock]' && c[4] === 'android'));
  x.foreground(); await flush(); assert.equal(x.calls.filter(c => c[0] === 'register').length, 3);
  await x.notificationService.setSession(null);
  assert(x.calls.some(c => c[0] === 'dismiss')); assert(x.calls.some(c => c[0] === 'response-clear'));
  stop(); assert.deepEqual(x.listeners(), [null, null]);
});

test('permanently denied Android permission never prompts; blocked reminder channel also denies', async () => {
  const x = runtime();
  x.native.getPermissionsAsync = async () => ({ granted: false, canAskAgain: false });
  assert.equal(await x.notificationPermission(true), false); assert.equal(x.calls.length, 0);
  x.native.getPermissionsAsync = async () => ({ granted: true });
  x.channels.set('friend-reminders', { importance: 0 });
  assert.equal(await x.notificationPermission(false), false);
});

test('iOS authorization includes provisional and uses the actual iOS platform', async () => {
  const x = runtime('ios');
  x.native.getPermissionsAsync = async () => ({ granted: false, ios: { status: 3 }, canAskAgain: false });
  await x.notificationService.setSession(session('a')); await x.notificationService.enable();
  assert.equal(x.calls.filter(c => c[0] === 'channel').length, 0);
  assert.equal(x.calls.find(c => c[0] === 'register')[4], 'ios');
});

test('Android notification-settings intent uses the application package with a fallback', async () => {
  const x = runtime(); await x.openNotificationSettings();
  assert.equal(x.calls[0][1], 'android.settings.APP_NOTIFICATION_SETTINGS');
  assert.equal(x.calls[0][2][0].key, 'android.provider.extra.APP_PACKAGE');
  assert.equal(x.calls[0][2][0].value, 'com.haddadgavriel.habittracker');
  x.linking.sendIntent = async () => { throw Error('unsupported'); };
  await x.openNotificationSettings(); assert.equal(x.calls.at(-1)[0], 'settings');
});

test('Settings and Diagnostics share controls; controls expose safe status and invoke service actions', async () => {
  const calls = []; const state = { status: 'denied', message: 'Notifications are blocked.', busy: false, cleanupPending: true };
  const localState = { status: 'off', enabled: false };
  const service = { snapshot: () => state, subscribe() {}, enable: () => calls.push('enable'), disable: () => calls.push('disable'), retryCleanup: () => calls.push('cleanup') };
  const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props };
  const controls = compile('components/notification-controls.tsx', name => ({
    react: { useState: x => [x, () => {}], useSyncExternalStore: (_, snapshot) => snapshot() },
    ...require('./native-ui-support.cjs'),
    'react/jsx-runtime': { jsx, jsxs: jsx }, 'react-native': { Button: 'Button', Text: 'Text', View: 'View' },
    '../lib/notification-runtime': { notificationService: service, openNotificationSettings: async () => calls.push('settings') },
    '../lib/local-reminder-runtime': { localReminderService: { snapshot: () => localState, subscribe() {}, disable: async () => calls.push('local-disable') } },
    './local-reminder-controls': { LocalReminderControls: () => null },
  })[name]);
  const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : !tree || typeof tree !== 'object' ? [] : [tree, ...nodes(tree.props.children)];
  const tree = controls.NotificationControls();
  for (const title of ['Enable notifications', 'Disable notifications', 'Open system notification settings']) {
    await nodes(tree).find(n => n.props.title === title).props.onPress();
  }
  await nodes(controls.NotificationCleanupNotice()).find(n => n.props.title === 'Retry notification cleanup').props.onPress();
  assert.deepEqual(calls, ['enable', 'local-disable', 'disable', 'settings', 'cleanup']);
  localState.status = 'error'; state.cleanupPending = false;
  const cleanup = nodes(controls.NotificationCleanupNotice()).find(n => n.props.title === 'Retry local reminder cleanup');
  assert.ok(cleanup); await cleanup.props.onPress();
  assert.equal(calls.at(-1), 'local-disable');
  for (const screen of ['settings', 'diagnostics']) {
    const source = readFileSync(`${__dirname}/../app/${screen}.tsx`, 'utf8');
    assert(source.includes('<NotificationControls />'));
    assert(!source.includes('registerDevice(')); assert(!source.includes('getExpoPushTokenAsync'));
  }
});
