const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { compile } = require('./sharing-test-support.cjs');
const cache = {};
const load = name => cache[name] ??= compile(`lib/${name}.ts`, path => load(path.slice(2)));
const { profileInput, profileUpdateInput } = load('profile-input');
const jsx = (type, props) => typeof type === 'function' ? type(props) : {type, props};
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree,...nodes(tree.props.children)] : [];

function settings(timezone = 'Factory') {
  const slots = [], calls = []; let index = 0;
  let profile = {username:'reviewer',display_name:'Original',timezone};
  const modules = {
    '../components/ui': {Button:'Button',Link:'Link'},
    'react/jsx-runtime': {jsx,jsxs:jsx},
    react: {
      useState: initial => {const i=index++; if (!(i in slots)) slots[i]=initial; return [slots[i], value=>slots[i]=value];},
      useRef: initial => {const i=index++; return slots[i]??={current:initial};},
    },
    'react-native': {Text:'Text',Alert:{}},
    '../components/form': {Field:'Field',Form:'Form',Message:'Message',styles:{}},
    '../components/notification-controls': {NotificationControls:'NotificationControls'},
    '../components/account-deletion-gate': {useAccountDeletion:()=>({})},
    '../lib/api': load('api'), '../lib/profile-input': load('profile-input'),
    '../lib/session': {useSession:()=>({profile,session:{user:{id:'owner'}},store:{
      update: async patch=>{calls.push({...patch});profile={...profile,...patch};return true;},
      snapshot:()=>({profile}), refreshProfile:async()=>true,
    }})},
  };
  const Settings=compile('app/settings.tsx',name=>modules[name]).default;
  const render=()=>{index=0;return nodes(Settings());};
  const field=(label,value)=>render().find(n=>n.type==='Field' && n.props.label===label).props.onChangeText(value);
  const press=title=>render().find(n=>n.type==='Button' && n.props.title===title).props.onPress();
  return {calls,field,press,render,setProfile:value=>profile=value};
}

test('Settings sends only edited fields and retains unsupported legacy timezone until explicitly changed', async()=>{
  const ui=settings();
  ui.field('Display name',' New name '); await ui.press('Save settings');
  assert.deepEqual(ui.calls,[{display_name:'New name'}]);
  assert.equal(ui.render().find(n=>n.props.label==='IANA profile timezone').props.value,'Factory');
  await ui.press('Save settings'); assert.equal(ui.calls.length,1,'confirmed save updates the baseline');
  ui.field('Username',' RENAMED '); await ui.press('Save settings');
  assert.deepEqual(ui.calls[1],{username:'renamed'});
  ui.field('IANA profile timezone','Asia/Jerusalem'); await ui.press('Save settings');
  assert.deepEqual(ui.calls[2],{timezone:'Asia/Jerusalem'});
});

test('Settings reload replaces the edit baseline without manufacturing timezone writes', async()=>{
  const ui=settings();
  ui.setProfile({username:'reviewer',display_name:'Reloaded',timezone:'EST'});
  await ui.press('Reload saved profile');
  await ui.press('Save settings'); assert.equal(ui.calls.length,0);
  ui.field('Display name','New name'); await ui.press('Save settings');
  assert.deepEqual(ui.calls,[{display_name:'New name'}]);
});

test('partial input validates changed fields and never normalizes an unchanged legacy zone',()=>{
  const saved={username:'reviewer',display_name:'Original',timezone:'Factory'};
  assert.deepEqual({...profileUpdateInput({...saved,display_name:'Original '},saved)},{});
  assert.throws(()=>profileUpdateInput({...saved,display_name:''},saved),/Display name/);
  assert.throws(()=>profileUpdateInput({...saved,username:'a'},saved),/Username/);
  assert.throws(()=>profileUpdateInput({...saved,timezone:''},saved),/timezone/);
  assert.throws(()=>profileUpdateInput({...saved,timezone:'+05:00'},saved),/timezone/);
});

test('actual onboarding suggestions from Intl belong to the backend/native catalog',()=>{
  const catalog=new Set(readFileSync(`${__dirname}/../../backend/app/data/timezones-v1.txt`,'utf8').split('\n'));
  const source=readFileSync(`${__dirname}/../lib/timezone-suggestion.ts`,'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const aliases=require('../lib/timezone-aliases.json');
  // Exercise the production default generator with the real installed Intl data,
  // including canonical/alias outputs; native timezone availability has separate tests.
  const zones=new Set([...Intl.supportedValuesOf('timeZone'),'Asia/Kolkata','Asia/Kathmandu','Europe/Kyiv','America/Nuuk']);
  for(const zone of zones) {
    const intl={DateTimeFormat:()=>new Intl.DateTimeFormat('en-US',{timeZone:zone})};
    const exports={};
    vm.runInNewContext(code,{Intl:intl,exports,require:()=>aliases});
    const suggested=exports.deviceTimezone();
    const input=profileInput({username:'reviewer',display_name:'Reviewer',timezone:suggested});
    assert.ok(catalog.has(input.timezone),`${zone} suggests ${input.timezone}`);
  }
  for(const output of [null,'',...Object.keys(aliases)]) {
    const exports={};
    const intl={DateTimeFormat:()=>{if(output===null)throw Error('unavailable');return {resolvedOptions:()=>({timeZone:output})};}};
    vm.runInNewContext(code,{Intl:intl,exports,require:()=>aliases});
    assert.equal(exports.deviceTimezone(),aliases[output]??output??'');
  }
});
