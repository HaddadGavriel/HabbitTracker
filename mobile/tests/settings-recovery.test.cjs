const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const cache = {};
function load(name) {
  if (cache[name]) return cache[name];
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(`${__dirname}/../lib/${name}.ts`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: p => load(p.slice(2)), process: { env: {} }, URL, URLSearchParams, setTimeout, clearTimeout, performance });
  return cache[name] = exports;
}
const { SessionStore } = load('session-store');
const { ApiError } = load('api');
const { AuthLinks, parseAuthLink, authRedirect } = load('auth-links');
const { EmailRequest } = load('email-request');
const { listenAuthLinks } = load('auth-link-listener');
const session = (id = 'a', token = 'old') => ({ user: { id, email: `${id}@example.test` }, access_token: token, refresh_token: 'refresh' });
const profile = (id = 'a', timezone = 'UTC') => ({ user_id: id, username: 'alice', display_name: 'Alice', timezone });
const input = { username: 'newname', display_name: 'New name', timezone: 'Asia/Tokyo' };
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = () => new Promise(r => setImmediate(r));
function sessions(updateProfile) {
  let callback;
  const auth = { getSession: async () => ({ data: { session: session() } }), onAuthStateChange: cb => { callback = cb; return { data: { subscription: { unsubscribe() {} } } }; }, signOut: async () => ({ error: null }), refreshSession: async () => ({ data: { session: session('a', 'new') }, error: null }) };
  const api = { readProfile: async s => profile(s.user.id), createProfile: async s => profile(s.user.id), updateProfile };
  return { store: new SessionStore(auth, api), event: s => callback('SIGNED_IN', s), auth, api };
}
test('settings publishes confirmed profile, preserves renewed token, and blocks duplicate writes', async () => {
  const pending = deferred(); const x = sessions(() => pending.promise); await x.store.start();
  const old = x.store.state.profile; const save = x.store.update(input);
  assert.equal(x.store.state.profile, old);
  await assert.rejects(x.store.update(input), /already in progress/);
  x.event(session('a', 'renewed'));
  pending.resolve({ ...profile(), ...input }); assert.equal(await save, true);
  assert.equal(x.store.state.profile.timezone, 'Asia/Tokyo'); assert.equal(x.store.state.session.access_token, 'renewed');
});
test('401 renews once using fresh token; failed renewal and second 401 preserve old profile', async () => {
  let calls = []; const x = sessions(async s => { calls.push(s.access_token); if (s.access_token === 'old') throw new ApiError('', 401, 'http_401'); return { ...profile(), ...input }; });
  await x.store.start(); await x.store.update(input); assert.deepEqual(calls, ['old','new']);
  assert.equal(x.store.state.session.access_token, 'new');
  for (const failsRenewal of [true,false]) {
    let writes = 0; const y = sessions(async () => { writes++; throw new ApiError('',401,'http_401'); }); await y.store.start();
    if (failsRenewal) y.auth.refreshSession = async () => ({ data: { session: null }, error: {} });
    await assert.rejects(y.store.update(input)); assert.equal(writes, failsRenewal ? 1 : 2); assert.equal(y.store.state.profile.timezone, 'UTC');
  }
});
test('conflicts and unavailable timezone preserve confirmed profile without retry', async () => {
  for (const [status,code] of [[409,'username_taken'],[422,'validation_error'],[null,'request_timeout']]) {
    let writes = 0; const x = sessions(async () => { writes++; throw new ApiError('',status,code); }); await x.store.start();
    await assert.rejects(x.store.update(input), e => e.code === code); assert.equal(writes,1); assert.equal(x.store.state.profile.username,'alice');
  }
});
test('account switches including A→B→A, logout, and stop discard late saves', async () => {
  for (const mode of ['switch','roundtrip','logout','stop','restart']) {
    const pending = deferred(), x = sessions(() => pending.promise); await x.store.start(); const save = x.store.update(input);
    if (mode === 'logout') await x.store.signOut(); else if (mode === 'stop' || mode === 'restart') { x.store.stop(); if (mode === 'restart') await x.store.start(); } else { x.event(session('b')); await flush(); if (mode === 'roundtrip') { x.event(session()); await flush(); } }
    pending.resolve({ ...profile(), ...input }); assert.equal(await save,false); assert.notEqual(x.store.state.profile?.timezone,'Asia/Tokyo');
  }
});
test('timezone save refreshes real Today and history stores and supersedes old date response', async () => {
  const x = sessions(async () => ({ ...profile(), ...input })); await x.store.start();
  const { TodayStore } = load('today-store'); const { HistoryStore } = load('history-store');
  const first = deferred(); let todayReads = 0, historyReads = 0, streakReads = 0;
  const today = new TodayStore(x.store, async () => { if (++todayReads === 1) return first.promise; return { local_date: '2026-10-21', timezone: 'Asia/Tokyo', server_time: '2026-10-21T01:00:00Z', occurrences: [] }; }, async () => {}, async () => {});
  const history = new HistoryStore(x.store, { readHabitHistory: async () => { historyReads++; return { habit_id:'habit', occurrences:[], next_cursor:null }; }, readHabitStreak: async () => { streakReads++; return { habit_id:'habit',current_streak:0,provisional:false,calculated_at:'2026-10-21T01:00:00Z' }; } }, 'habit');
  today.start(); history.start(); await flush(); await x.store.update(input); await flush();
  first.resolve({ local_date:'2026-10-20',timezone:'UTC',server_time:'2026-10-20T01:00:00Z',occurrences:[] }); await flush();
  assert.equal(today.snapshot().today.timezone,'Asia/Tokyo'); assert.equal(todayReads,2); assert.equal(historyReads,2); assert.equal(streakReads,2);
  today.stop(); history.stop();
});
const link = (type='recovery', hash='unused') => `${authRedirect}?token_hash=${hash}&type=${type}`;
function recovery(current = undefined, behavior = {}) {
  let account = current, updates = [], verifications = [];
  const auth = { verifyOtp: async p => { verifications.push(p); return { data:{session:session('b')},error:null }; }, setSession: async () => ({ data:{session:session('b')},error:null }), getUser: async () => ({ data:{user:session('b').user},error:null }), updateUser: async p => { updates.push(p); return { error:null }; }, ...behavior };
  return { store: new AuthLinks(() => auth, () => account), auth, updates, verifications, account: id => { account = id; } };
}
test('only supported callback routes, kinds, and nonambiguous parameters are accepted', () => {
  assert.equal(parseAuthLink(link()).kind,'recovery');
  assert.equal(parseAuthLink('habittrackerinfra://#access_token=a&refresh_token=b&type=signup').kind,'signup');
  assert.equal(parseAuthLink('habittrackerinfra://home'),null);
  for (const raw of [link()+'&type=signup',link()+'&code=abc',link('email_change'),link()+'#type=recovery','habittrackerinfra://home?token_hash=x&type=recovery',authRedirect+'?access_token=x&type=recovery',link()+'&next=/home',link()+'&error_description=secret',link()+'&expires_in=%ZZ']) assert.throws(() => parseAuthLink(raw), /invalid/);
});
test('recovery remains isolated and mismatched accounts require explicit continue', async () => {
  const x = recovery('a'); await x.store.open(link()); assert.equal(x.store.snapshot().phase,'decision');
  await x.store.updatePassword('abcdef','abcdef'); assert.equal(x.updates.length,0);
  x.store.continue(); assert.equal(x.store.snapshot().phase,'recovery');
  await x.store.updatePassword('abcdef','abcdef'); assert.equal(x.store.snapshot().phase,'updated'); assert.equal(x.updates.length,1);
});
test('account change while form is open requires a new decision; cancel never updates passwords', async () => {
  const x = recovery('b'); await x.store.open(link()); x.account('a');
  await x.store.updatePassword('abcdef','abcdef'); assert.equal(x.store.snapshot().phase,'decision'); assert.equal(x.updates.length,0);
  x.store.cancel(); x.store.continue(); assert.equal(x.store.snapshot().phase,'idle');
});
test('expired/reused/malformed links are safe errors; signup confirmation never enters recovery', async () => {
  for (const behavior of [{verifyOtp:async()=>({error:{message:'secret token'},data:{session:null}})},{getUser:async()=>({error:{},data:{user:null}})}]) {
    const x = recovery(undefined,behavior); await x.store.open(link()); assert.equal(x.store.snapshot().phase,'error'); assert.ok(!x.store.snapshot().error.includes('secret token'));
  }
  const x = recovery(); await x.store.open(link('signup')); assert.equal(x.store.snapshot().phase,'confirmed'); await x.store.updatePassword('abcdef','abcdef'); assert.equal(x.updates.length,0);
  await x.store.open(authRedirect+'?error_code=otp_expired&error_description=secret'); assert.equal(x.store.snapshot().phase,'error');
});
test('password errors stay in recovery, prevent concurrent writes, and late results cannot reopen cancelled flow', async () => {
  const pending = deferred(); const x = recovery(undefined,{updateUser:()=>pending.promise}); await x.store.open(link());
  await x.store.updatePassword('short','short'); assert.equal(x.store.snapshot().phase,'recovery'); assert.match(x.store.snapshot().error,/6 characters/);
  const save = x.store.updatePassword('abcdef','abcdef'); await x.store.updatePassword('abcdef','abcdef');
  pending.resolve({error:{message:'secret'}}); await save; assert.equal(x.store.snapshot().phase,'recovery'); assert.match(x.store.snapshot().error,/failed/);
  const late = deferred(); x.auth.updateUser = () => late.promise; const again=x.store.updatePassword('abcdef','abcdef'); x.store.cancel(); late.resolve({error:null}); await again; assert.equal(x.store.snapshot().phase,'idle');
});
test('superseded link verification and duplicated delivery cannot replace the current flow', async () => {
  const pending = deferred(); const x = recovery(undefined,{verifyOtp:()=>pending.promise}); const old=x.store.open(link()); x.store.cancel(); pending.resolve({data:{session:session('b')},error:null}); await old;
  assert.equal(x.store.snapshot().phase,'idle'); await x.store.open(link()); assert.equal(x.store.snapshot().phase,'error');
});
test('cold-start URL waits for persisted identity; warm delivery wins delayed initial URL; cleanup ignores late links', async () => {
  let callback, removed=0; const initial=deferred(), x=recovery('a');
  const source = { snapshot:()=>({status:'ready'}),subscribe:()=>()=>{} };
  const linking={getInitialURL:()=>initial.promise,addEventListener:(_,cb)=>{callback=cb;return {remove:()=>removed++};}};
  const listener=listenAuthLinks(linking,source,x.store); callback({url:link('recovery','warm')}); await flush(); initial.resolve(link('signup','cold')); await listener.ready;
  assert.equal(x.store.snapshot().phase,'decision'); assert.equal(x.verifications[0].token_hash,'warm'); listener.stop(); assert.equal(removed,1);
  callback({url:link('signup','later')}); await flush(); assert.equal(x.store.snapshot().phase,'idle');
  const y=recovery('a'); let restored=false, notify; const cold=listenAuthLinks({getInitialURL:async()=>link(),addEventListener:()=>({remove(){}})}, {snapshot:()=>({status:restored?'ready':'startup'}),subscribe:cb=>{notify=cb; return ()=>{};}},y.store);
  await flush(); assert.equal(y.verifications.length,0); restored=true; notify(); await cold.ready; assert.equal(y.store.snapshot().phase,'decision'); cold.stop();
});
test('recovery and confirmation submission cooldowns, nonenumerating messages, rate limits and transport errors', async () => {
  let now=0, calls=[];
  const api={resetPasswordForEmail:async(...args)=>{calls.push(args);return {error:null};},resend:async(...args)=>{calls.push(args);return {error:{status:400,message:'unknown account'}};}};
  const requests=new EmailRequest(api,()=>now); const success=await requests.send('a@example.test'); assert.match(success,/If this address/); assert.equal(calls[0][1].redirectTo,authRedirect);
  assert.match(await requests.send('a@example.test'),/wait/); assert.equal(calls.length,1);
  now=60_001; assert.match(await requests.send('a@example.test',true),/If confirmation/); assert.equal(calls[1][0].options.emailRedirectTo,authRedirect);
  now+=60_001; api.resetPasswordForEmail=async()=>({error:{status:429}}); assert.match(await requests.send('a@example.test'),/Too many/);
  now+=60_001; api.resetPasswordForEmail=async()=>{throw Error('private');}; assert.match(await requests.send('a@example.test'),/Unable to contact/);
});
function compileScreen(path, modules) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(`${__dirname}/../${path}`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx:ts.JsxEmit.ReactJSX },
  }).outputText, { exports, Error, require: p => { if (!(p in modules)) throw Error('Unexpected dependency: '+p); return modules[p]; } });
  return exports;
}
const jsx = (type,props,key) => typeof type === 'function' ? type(props) : {type,props,key};
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : !tree || typeof tree !== 'object' ? [] : [tree,...nodes(tree.props?.children)];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : typeof tree === 'string' || typeof tree === 'number' ? String(tree) : tree && typeof tree === 'object' ? text(tree.props?.children) : '';
test('every recovery phase gates ordinary home/settings, even with a ready app session', () => {
  let phase='idle', status='ready'; const Stack = p => ({type:'Stack',props:p}); Stack.Screen='Screen'; Stack.Protected='Protected';
  const modules={
    'react/jsx-runtime':{jsx,jsxs:jsx},'expo-router':{Stack},'expo-notifications':{setNotificationHandler(){}},
    '../lib/notification-runtime': { notificationService: { canPresent: () => false } },
    '../lib/session':{SessionProvider:p=>p.children,useSession:()=>({status,session:session()})},
    '../lib/session-store':load('session-store'),
    '../lib/auth-link-context':{AuthLinkProvider:p=>p.children,useAuthLink:()=>({phase})},
  };
  const Layout=compileScreen('app/_layout.tsx',modules).default;
  for (status of ['ready','signed_out','loading','failure','profile_required']) for (phase of ['idle','loading','decision','recovery','error','confirmed','updated']) {
    const groups=nodes(Layout()).filter(n=>n.type==='Protected');
    const access=route=>groups.find(g=>nodes(g.props.children).some(n=>n.type==='Screen'&&n.props.name===route)).props.guard;
    assert.equal(access('settings'),status==='ready'&&phase==='idle'); assert.equal(access('home'),status==='ready'&&phase==='idle');
    assert.equal(access('new-password'),phase==='recovery'); assert.equal(access('auth-callback'),phase!=='idle'&&phase!=='recovery');
    assert.equal(groups.filter(g=>g.props.guard).length,1);
  }
});
test('native routing strips callback credentials on cold and warm paths and preserves existing app links', () => {
  const {redirectSystemPath}=compileScreen('app/+native-intent.tsx',{});
  for (const initial of [true,false]) {
    for (const path of [link(), 'habittrackerinfra://#access_token=secret&refresh_token=secret&type=recovery',authRedirect+'?code=secret']) assert.equal(redirectSystemPath({path,initial}),'/auth-callback');
    assert.equal(redirectSystemPath({path:'habittrackerinfra://today',initial}),'habittrackerinfra://today');
  }
});
test('Settings screen edits validated fields, explains policy, renders read-only email and retains navigation on errors', async () => {
  const x=sessions(async()=>{throw new ApiError('taken',409,'username_taken');}); await x.store.start();
  let slots=[],index=0;
  const modules={
    'react/jsx-runtime':{jsx,jsxs:jsx},'react':{useState:initial=>{const i=index++; if (!(i in slots)) slots[i]=initial; return [slots[i],v=>{slots[i]=v;}];},useRef:initial=>{const i=index++;return slots[i]??=( {current:initial} );}},
    'react-native':{Text:'Text',Button:'Button'},'expo-router':{Link:'Link'},
    '../components/notification-controls': { NotificationControls: 'NotificationControls' },
    '../components/form':{Field:'Field',Form:'Form',Message:p=>p.text,styles:{}},'../lib/api':load('api'),'../lib/profile-input':load('profile-input'),
    '../lib/session':{useSession:()=>({...x.store.snapshot(),store:x.store})},
  };
  const Settings=compileScreen('app/settings.tsx',modules).default;
  const render=()=>{index=0;return Settings();};
  let tree=render(); assert.match(text(tree),/a@example.test/); assert.ok(!nodes(tree).some(n=>n.type==='Field'&&/Email/.test(n.props.label)));
  assert.match(text(tree),/Existing occurrence dates and deadlines remain fixed/);
  const name=nodes(tree).find(n=>n.type==='Field'&&n.props.label==='Username'); name.props.onChangeText('valid_name'); tree=render();
  await nodes(tree).find(n=>n.type==='Button'&&n.props.title==='Save settings').props.onPress(); tree=render();
  assert.match(text(tree),/already taken/); assert.ok(nodes(tree).some(n=>n.type==='Link'&&n.props.href==='/home')); assert.ok(nodes(tree).some(n=>n.type==='Button'&&n.props.title==='Sign out'));
});
