const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function compile(path, require, extras = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(`${__dirname}/../${path}`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require, Error, Date, Intl, performance, process: { env: {} }, ...extras });
  return exports;
}
const cache = {};
const lib = name => cache[name] ??= compile(`lib/${name}.ts`, path => lib(path.slice(2)));
const rules = lib('reminder-rules');
const habit = { id: 'habit', owner: { user_id: 'owner', display_name: 'Friend' }, configuration: { name: 'Read' },
  due_today: true, timezone: 'UTC', local_date: '2026-10-20', server_time: '2026-10-20T10:00:00Z',
  occurrence: { state: 'in_progress', completed: false, local_date: '2026-10-20', closes_at: '2026-10-21T00:00:00Z' } };
const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props };
function nodes(tree) { return Array.isArray(tree) ? tree.flatMap(nodes) : !tree || typeof tree !== 'object' ? [] : [tree, ...nodes(tree.props.children)]; }
function text(tree) { return Array.isArray(tree) ? tree.map(text).join(' ') : typeof tree === 'string' || typeof tree === 'number' ? String(tree) : tree && typeof tree === 'object' ? text(tree.props.children) : ''; }
function ui(requests = [], changes = {}) {
  let state = { habit: { loaded: true, busy: false, blocked: false, requests, message: null } };
  const calls = [], alerts = [], effects = [], cleanup = [];
  let clock = { wall: 1000, monotonic: 1000 }, tick;
  const service = { snapshot: () => state, subscribe() {}, load: (...args) => calls.push(['load', ...args]), send: (...args) => calls.push(['send', ...args]) };
  const session = { user: { id: 'sender' } };
  const Component = compile('components/reminder-controls.tsx', name => ({
    react: { useEffect: fn => effects.push(fn), useState: () => [0, () => {}], useSyncExternalStore: (_, get) => get() },
    ...require('./native-ui-support.cjs'),
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Alert: { alert: (...args) => alerts.push(args) }, Button: 'Button', Text: 'Text', View: 'View' },
    '../lib/reminder-rules': { ...rules, reminderEligible: (h, started) => rules.reminderEligible(h, started, clock) },
    '../lib/reminder-service': lib('reminder-service'), '../lib/reminder-runtime': { reminderService: service },
    '../lib/session': { useSession: () => ({ session }) }, './form': { styles: {} },
  })[name], { setInterval: fn => { tick = fn; return 1; }, clearInterval() {} }).ReminderControls;
  const props = { habit: { ...habit, ...changes }, observedAt: { wall: 1000, monotonic: 1000 } };
  const render = () => Component(props);
  const button = title => nodes(render()).find(n => n.type === 'Button' && n.props.title === title);
  render(); effects.splice(0).forEach(fn => cleanup.push(fn()));
  return { render, button, calls, alerts, props, state: value => { state.habit = { ...state.habit, ...value }; },
    elapsed: ms => { clock = { wall: 1000 + ms, monotonic: 1000 + ms }; tick(); },
    press: title => { const b = button(title); assert.ok(b, title); assert.ok(!b.props.disabled, title); b.props.onPress(); },
    stop: () => cleanup.forEach(fn => fn?.()) };
}

test('eligible shared habit exposes Remind and hydration never dispatches; elapsed original deadline removes it', () => {
  const x = ui(); assert.ok(x.button('Remind')); assert.match(text(x.render()), /server checks current access/);
  assert.deepEqual(x.calls, [['load', 'habit', 'sender', true]]);
  x.press('Remind'); assert.deepEqual(x.calls.at(-1), ['send', 'habit', 'sender']);
  x.elapsed(14 * 3600_000); assert.equal(x.button('Remind'), undefined); x.stop();
});

for (const status of Object.keys(rules.reminderLabels)) test(`UI reports ${status} without claiming phone delivery`, () => {
  const x = ui([{ key: 'original-key', status, retryAt: '2026-10-20T11:00:00Z', result: { status } }]);
  assert.ok(text(x.render()).includes(rules.reminderLabels[status]));
  assert.equal(x.button('Request new reminder').props.disabled, true);
  if (['reserved', 'unknown'].includes(status)) { x.press('Check same request'); assert.deepEqual(x.calls.at(-1), ['send', 'habit', 'sender', 'original-key']); }
  else assert.equal(x.button('Check same request'), undefined);
  x.stop();
});

test('unknown outcome requires an explicit duplicate confirmation after server-verified cooldown; cancel sends nothing', () => {
  const x = ui([{ key: 'original-key', status: 'unknown', retryAt: '2026-10-20T11:00:00Z', result: { status: 'unknown' } }], { server_time: '2026-10-20T11:01:00Z' });
  x.press('Request new reminder'); assert.equal(x.calls.filter(c => c[0] === 'send').length, 0);
  assert.match(x.alerts[0][1], /duplicate/); assert.equal(x.alerts[0][2][0].style, 'cancel');
  x.alerts[0][2][1].onPress(); assert.deepEqual(x.calls.at(-1), ['send', 'habit', 'sender', undefined, 'original-key']); x.stop();
});

test('unconfirmed request with no retry_at only allows the saved-key action; earlier unresolved keys remain checkable', () => {
  const x = ui([{ key: 'older-key', status: 'reserved', result: { status: 'reserved' } }, { key: 'newer-key', status: 'unconfirmed' }]);
  assert.equal(x.button('Request new reminder').props.disabled, true);
  x.press('Check earlier request 1'); assert.equal(x.calls.at(-1)[3], 'older-key');
  x.press('Check same request'); assert.equal(x.calls.at(-1)[3], 'newer-key');
  assert.match(text(x.render()), /can complete the original request/); x.stop();
});

test('completed habit still permits checking unresolved request, but no new request; busy or blocked access disables actions', () => {
  const x = ui([{ key: 'key', status: 'unconfirmed' }], { occurrence: { ...habit.occurrence, completed: true, state: 'completed' } });
  assert.equal(x.button('Request new reminder'), undefined); assert.ok(x.button('Check same request'));
  x.state({ busy: true }); assert.equal(x.button('Check same request').props.disabled, true);
  x.state({ busy: false, blocked: true, requests: [] }); assert.equal(x.button('Check same request'), undefined);
  assert.match(text(x.render()), /refresh current access/); x.stop();
});
