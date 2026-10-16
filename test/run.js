const fs = require('fs'), path = require('path');

function parseCSV(t) {
  const rows = []; let r = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c == '"') { if (t[i + 1] == '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c == '"') q = true;
    else if (c == ',') { r.push(f); f = ''; }
    else if (c == '\n' || c == '\r') { if (c == '\r' && t[i + 1] == '\n') i++; r.push(f); rows.push(r); r = []; f = ''; }
    else f += c;
  }
  if (f || r.length) { r.push(f); rows.push(r); }
  return rows;
}
// run an n8n Code-node file with stubbed $input / $
const run = (file, ctx) => new Function('$input', '$', fs.readFileSync(path.join(__dirname, '../code', file), 'utf8'))(ctx.$input, ctx.$);
const wrap = a => a.map(json => ({ json }));

const csv = parseCSV(fs.readFileSync(path.join(__dirname, 'requests-backlog.csv'), 'utf8')).filter(r => r.length > 1);
const head = csv.shift();
const raw = csv.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
const fake = require('./fake_llm');

function pipeline(rawRows, existingRows, llmAnswers) {
  const nodes = {};
  const $ = name => ({ all: () => nodes[name] });
  nodes['Read existing'] = wrap(existingRows.length ? existingRows : [{}]);
  nodes['Normalize'] = run('01_normalize.js', { $input: { all: () => wrap(rawRows) }, $ });
  nodes['Prep'] = run('02_prep.js', { $input: { all: () => nodes['Read existing'] }, $ });
  const answers = llmAnswers(nodes['Prep'].map(i => i.json));
  return run('03_postprocess.js', { $input: { all: () => wrap(answers) }, $ }).map(i => i.json);
}

const norm = s => s.trim().toLowerCase().replace(/\s+/g, ' ');
const byText = new Map(raw.map((r, i) => [norm(r.message), fake[i]]));
const answers = prep => prep.map(p => byText.get(p.message_norm) || { text: '' });

const out1 = pipeline(raw, [], answers);
fs.writeFileSync(path.join(__dirname, 'out_run1.json'), JSON.stringify(out1, null, 1));
console.log('rows:', out1.length);
console.log('#  received_at      sender                 team              urg      lang rep status | flags');
out1.forEach((r, i) => console.log(
  String(i + 1).padEnd(3) + r.received_at.padEnd(17) + ' ' + (r.sender_email || r.sender_name || '-').slice(0, 22).padEnd(22) + ' ' +
  r.team.padEnd(17) + ' ' + r.urgency.padEnd(8) + ' ' + r.language.padEnd(4) + ' ' + String(r.repeat_count).padEnd(3) + ' ' +
  r.status.slice(0, 6).padEnd(6) + ' | ' + r.flags + (r.incident_id ? ' | ' + r.incident_id + '#' + r.incident_size : '') + (r.alert ? ' | ALERT:' + r.alert : '')));
console.log('\nALERTS fired:', out1.filter(r => r.alert).length);
out1.filter(r => r.alert).forEach(r => console.log('---\n' + r.alert_text));

const out2 = pipeline(raw, out1.map(r => ({ ...r })), answers);
console.log('\nsecond run with stored rows -> new rows (expect 0):', out2.length);
const dup = pipeline([raw[26], raw[26]], [], answers);
console.log('same message twice in one batch -> rows (expect 1):', dup.length);
