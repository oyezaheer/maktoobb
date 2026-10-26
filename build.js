// Builds dist/index.html (and dist/notetime.html, which the test tools read) from src/template.html.
// Supabase settings come from src/config.js if it exists (local work),
// otherwise from the SUPABASE_URL and SUPABASE_KEY environment variables (deployment),
// otherwise sync is simply switched off.
const fs = require('fs');
const core = fs.readFileSync('src/core.js', 'utf8');
const sync = fs.readFileSync('src/sync.js', 'utf8');
const tpl = fs.readFileSync('src/template.html', 'utf8');

let cfg, source;
if (fs.existsSync('src/config.js')) {
  cfg = fs.readFileSync('src/config.js', 'utf8'); source = 'src/config.js';
} else if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
  const safe = JSON.stringify({ SUPABASE_URL: process.env.SUPABASE_URL.trim(), SUPABASE_KEY: process.env.SUPABASE_KEY.trim() }).replace(/</g, '\\u003c');
  cfg = 'window.NT_CONFIG = ' + safe + ';'; source = 'environment variables';
} else {
  cfg = 'window.NT_CONFIG = {};'; source = 'none (cloud sync switched off)';
}

for (const m of ['/*__CORE__*/', '/*__SYNC__*/', '/*__CONFIG__*/']) if (!tpl.includes(m)) throw new Error('marker missing: ' + m);
const out = tpl.replace('/*__CONFIG__*/', () => cfg).replace('/*__CORE__*/', () => core).replace('/*__SYNC__*/', () => sync);
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', out);
fs.writeFileSync('dist/notetime.html', out);
console.log('built dist/index.html (' + out.length + ' bytes), Supabase config from: ' + source);
