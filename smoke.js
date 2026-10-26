// Usage: node smoke.js     (run after `npm run build`)
// Loads dist/notetime.html in a simulated browser and reports what really happens.
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');

const html = fs.readFileSync('dist/notetime.html', 'utf8');
const body = html.replace(/<script src[^>]*><\/script>/g, '').replace(/<link[^>]*>/g, '');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const lib = (f) => { const p = path.join('node_modules', f); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };

const problems = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => problems.push('page error: ' + String((e.detail && e.detail.stack) || e.message).split('\n').slice(0, 3).join(' | ')));
vc.on('error', (...a) => problems.push('console.error: ' + a.join(' ').slice(0, 300)));

const dom = new JSDOM(body, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost:3000/notetime', virtualConsole: vc });
const w = dom.window;
w.indexedDB = new IDBFactory(); w.IDBKeyRange = IDBKeyRange; w.fetch = globalThis.fetch;
w.requestAnimationFrame = (f) => setTimeout(f, 0);

function run(name, code) {
  if (code == null) { console.log('  MISSING ', name, '(not installed)'); return false; }
  try { w.eval(code); console.log('  loaded  ', name); return true; }
  catch (e) { problems.push('while loading ' + name + ': ' + String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ')); console.log('  FAILED  ', name); return false; }
}

console.log('Loading your built page (dist/notetime.html):');
console.log('  inline scripts found:', inline.length, '(expected 4: config, core, sync, app)');
run('react', lib('react/umd/react.production.min.js'));
run('react-dom', lib('react-dom/umd/react-dom.production.min.js'));
run('dexie', lib('dexie/dist/dexie.min.js'));
const sb = lib('@supabase/supabase-js/dist/umd/supabase.js');
if (sb) run('supabase-js', sb);
else console.log('  note     supabase-js not installed here, so a stand-in is used (run: npm i -D @supabase/supabase-js@2.117.3 for a stricter test)');
if (!sb) w.supabase = { createClient: () => ({ auth: { onAuthStateChange() {}, signOut: async () => ({}) }, from() { return {}; }, channel() { return { on() { return this; }, subscribe() { return this; } }; }, removeChannel() {} }) };
['config.js', 'core.js', 'sync.js', 'app'].forEach((n, i) => { if (inline[i] != null) run(n, inline[i]); else problems.push('inline script #' + i + ' (' + n + ') is missing from the build'); });

setTimeout(() => {
  const q = (s) => w.document.querySelector(s);
  console.log('\nWhat the page shows after 4 seconds:');
  console.log('  #root element present :', !!q('#root'));
  console.log('  app frame (.app)      :', !!q('.app'));
  console.log('  sidebar (app ready)   :', !!q('.sidebar'));
  console.log('  sync line             :', q('.sync-line') ? q('.sync-line').textContent : '(none)');
  console.log('  loading message       :', q('[role=alert]') ? q('[role=alert]').textContent.slice(0, 70) + '...' : '(none)');
  console.log('\nProblems found:', problems.length ? '' : 'none');
  problems.forEach((p) => console.log('  -', p));
  let verdict;
  if (problems.length) verdict = 'The error(s) above are the cause. Send them to me.';
  else if (!q('#root')) verdict = 'The page has no <div id="root">. It was lost from the HTML.';
  else if (!q('.app')) verdict = 'The app never rendered, but nothing crashed. Send me src/template.html.';
  else if (!q('.sidebar')) verdict = 'The app frame renders but it never finishes starting (stuck on loading).';
  else verdict = 'This page WORKS in a simulated browser. If your real browser still shows nothing, the cause is browser-side: hard refresh (Ctrl+Shift+R), try a private window, or turn Brave Shields off for localhost.';
  console.log('\nVerdict:', verdict);
  process.exit(0);
}, 4000);