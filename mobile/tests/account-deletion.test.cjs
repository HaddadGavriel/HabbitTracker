const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compile, deferred } = require('./sharing-test-support.cjs');
const { AccountDeletionStore } = compile('lib/account-deletion-store.ts', () => { throw new Error('unexpected dependency'); });
const receipt = 'a'.repeat(64);
async function setup(overrides = {}, stored = []) {
  const calls = [];
  let journal = stored;
  const deps = {
    load: async () => journal,
    save: async value => { calls.push('save'); journal = value; },
    newReceipt: () => receipt,
    currentOwner: () => 'a', subscribeAccount: () => () => {},
    begin: async () => { calls.push('dispatch'); return { state:'pending' }; },
    recover: async () => ({ state:'pending' }),
    cleanup: async () => { calls.push('cleanup'); return true; },
    ...overrides,
  };
  const store = new AccountDeletionStore(deps);
  await store.start();
  return { store, calls, deps, journal: () => journal };
}
test('explicit confirmation and password are required before persisting or sending', async () => {
  const x = await setup();
  for (const [password, confirmation] of [['','DELETE MY ACCOUNT'],['secret','delete'],['secret','']]) {
    await assert.rejects(x.store.begin(password, confirmation, 'a'), /current password/);
  }
  assert.equal(x.calls.length,0);
});
test('receipt is durable before dispatch, pending clears local data but retains receipt', async () => {
  const x = await setup();
  await x.store.begin('password','DELETE MY ACCOUNT','a');
  assert.equal(x.calls.join(','),'save,dispatch,cleanup');
  assert.equal(x.journal()[0].receipt,receipt); assert.equal(x.store.snapshot().phase,'pending');
  x.store.dismiss(); assert.equal(x.store.snapshot().phase,'pending');
});
test('storage failure dispatches nothing; ambiguous network result retains same receipt for retry', async () => {
  const x = await setup({ save: async () => { throw Error('disk'); } });
  await x.store.begin('password','DELETE MY ACCOUNT','a');
  assert.equal(x.calls.length,0); assert.equal(x.store.snapshot().phase,'error');
  const y = await setup({ begin: async () => { throw Error('password token must not escape'); } });
  await y.store.begin('password','DELETE MY ACCOUNT','a');
  assert.equal(y.journal()[0].receipt,receipt); assert.equal(y.store.snapshot().phase,'error');
  assert.ok(!y.store.snapshot().message.includes('token'));
  assert.equal(y.calls.includes('cleanup'),false);
  await y.store.recover(); assert.equal(y.store.snapshot().phase,'pending');
});
test('restart recovers without password/session and only confirms after all cleanup succeeds', async () => {
  let fail = true;
  const x = await setup({ recover: async () => ({ state:'complete' }), cleanup: async () => { if (fail) throw Error('native'); return true; } },[{owner:'a',receipt}]);
  assert.equal(x.store.snapshot().phase,'error'); assert.equal(x.journal()[0].receipt,receipt);
  fail = false; await x.store.recover();
  assert.equal(x.store.snapshot().phase,'complete'); assert.equal(x.journal().length,0);
  assert.equal(x.store.snapshot().message,'Account deleted.');
});
test('unknown receipt allows returning to settings while retaining credential for late commits', async () => {
  const x = await setup({ recover: async () => ({ state:'not_found' }) }, [{owner:'a',receipt}]);
  assert.equal(x.store.snapshot().phase,'not_found'); x.store.dismiss();
  assert.equal(x.store.snapshot().phase,'idle'); assert.equal(x.journal()[0].receipt,receipt);
  assert.equal(x.calls.includes('cleanup'),false);
});
test('duplicate submissions and recoveries cannot dispatch while request is in flight', async () => {
  const wait = deferred(); let requests = 0;
  const x = await setup({ begin: () => { requests++; return wait.promise; } });
  const first = x.store.begin('password','DELETE MY ACCOUNT','a');
  await x.store.begin('password','DELETE MY ACCOUNT','a'); await x.store.recover();
  wait.resolve({ state:'complete' }); await first;
  assert.equal(requests,1); assert.equal(x.store.snapshot().phase,'complete');
});

const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props };
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props.children)] : [];
function settings() {
  const state = [], calls = []; let index = 0;
  const modules = {
    ...require('./native-ui-support.cjs'),
    'react/jsx-runtime': { jsx, jsxs:jsx },
    react: { useState: initial => { const i=index++; state[i] ??= initial; return [state[i], value => { state[i]=value; }]; }, useRef: value => ({current:value}) },
    'react-native': { Button:'Button', Text:'Text' }, 'expo-router': { Link:'Link' },
    '../components/form': { Field:'Field', Form:'Form', Message:'Message', styles:{} },
    '../components/notification-controls': { NotificationControls:'NotificationControls' },
    '../components/account-deletion-gate': { useAccountDeletion: () => ({ begin: async (...args) => calls.push(args) }) },
    '../lib/api': { ApiError: class extends Error {} }, '../lib/profile-input': { profileInput:x=>x },
    '../lib/session': { useSession: () => ({ profile:{username:'alice',display_name:'Alice',timezone:'UTC'},session:{user:{id:'validated-user',email:'a@example.com'}},store:{} }) },
  };
  const Settings = compile('app/settings.tsx', name => { assert.ok(modules[name],name); return modules[name]; }).default;
  const render = () => { index=0; return nodes(Settings()); };
  const press = async title => { const node=render().find(n=>n.type==='Button' && n.props.title===title); assert.ok(node,title); assert.ok(!node.props.disabled); await node.props.onPress(); };
  const field = (label,value) => render().find(n=>n.type==='Field' && n.props.label===label).props.onChangeText(value);
  return {render,press,field,calls};
}
test('real Settings destructive controls require exact phrase, mask password and support cancel', async () => {
  const x=settings(); await x.press('Delete my account…');
  let button=x.render().find(n=>n.props.title==='Permanently delete my account'); assert.equal(button.props.disabled,true);
  const password=x.render().find(n=>n.props.label==='Current password'); assert.equal(password.props.secureTextEntry,true);
  x.field('Current password','current'); x.field('Type DELETE MY ACCOUNT to confirm','DELETE MY ACCOUNT');
  await x.press('Cancel deletion'); assert.equal(x.calls.length,0);
  await x.press('Delete my account…');
  assert.equal(x.render().find(n=>n.props.label==='Current password').props.value,'');
  x.field('Current password','current'); x.field('Type DELETE MY ACCOUNT to confirm','DELETE MY ACCOUNT');
  await x.press('Permanently delete my account');
  assert.equal(x.calls.length,1); assert.equal(x.calls[0].join(','),'current,DELETE MY ACCOUNT,validated-user');
  assert.equal(x.render().find(n=>n.props.label==='Current password').props.value,'');
});
test('deleted decision maker is accepted only with null identity', () => {
  const { validateExcuse }=compile('lib/excuse-detail-store.ts', name => name==='./api' ? {ApiError:class extends Error {}} : {});
  const row={id:'e',explanation:'Saved',status:'approved',occurrence_id:'o',owner_id:'a',habit_id:'h',decision_source:'deleted_friend',decided_by:null,decided_at:'2026-10-22T12:00Z',occurrence:{id:'o',owner_id:'a',habit_id:'h',state:'excused',completed:false}};
  assert.doesNotThrow(()=>validateExcuse(row));
  assert.throws(()=>validateExcuse({...row,decided_by:'fake-profile'}));
});

test('actual excuse view labels deleted friend and keeps the decision timestamp', () => {
  const modules={...require('./native-ui-support.cjs'),
    'react/jsx-runtime':{jsx,jsxs:jsx},'react-native':{Text:'Text',View:'View'},'./form':{styles:{}}};
  const { ExcuseView }=compile('components/excuse-view.tsx',name=>modules[name]);
  const tree=nodes(ExcuseView({excuse:{status:'approved',explanation:'Preserved history',created_at:'created',decided_at:'original-time',decision_source:'deleted_friend',decided_by:null}}));
  const text=tree.filter(n=>n.type==='Text').map(n=>(Array.isArray(n.props.children)?n.props.children.join(''):n.props.children)).join(' ');
  assert.match(text,/Decision: Deleted friend/); assert.match(text,/original-time/); assert.match(text,/Preserved history/);
  assert.doesNotMatch(text,/Decided by:/);
});
