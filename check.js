// Usage: node check.js   (run after `npm run build`)
const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync('dist/notetime.html', 'utf8');
const re = /<script>([\s\S]*?)<\/script>/g;
let m, i = 0, bad = 0;
while ((m = re.exec(html))) {
  const code = m[1];
  const startLine = html.slice(0, m.index + '<script>'.length).split('\n').length;
  try {
    new vm.Script(code, { filename: 'script-' + i });
    console.log('script', i, 'OK');
  } catch (e) {
    bad++;
    const rel = Number((/script-\d+:(\d+)/.exec(e.stack) || [])[1] || 0);
    const line = startLine + rel - 1;
    console.log('script', i, 'SYNTAX ERROR:', e.message);
    console.log('  -> dist/notetime.html line', line);
    console.log('  ->', (html.split('\n')[line - 1] || '').trim().slice(0, 140));
  }
  i++;
}
console.log(bad ? '\nFix the error above, run npm run build, then run this again.' : '\nNo syntax errors. If the page is still blank, open the browser console (F12) and read the red error.');