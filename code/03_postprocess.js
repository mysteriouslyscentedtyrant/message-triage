// n8n Code node  |  name it exactly: Postprocess  |  Mode: Run Once for All Items
// Input : output of the LLM node (one item per message, same order as the Prep node)
// Does  : parse + validate LLM JSON (never crashes), apply guardrails, repeat-contact + incident logic,
//         split multi-topic messages, decide which rows need a Slack/email alert.

const TODAY = '2026-10-12';
const TEAMS = ['Support', 'Tech', 'Billing', 'Deliverability', 'Migration', 'Product', 'Security & Legal'];
const LEVELS = ['low', 'normal', 'high', 'critical'];
const lvl = u => LEVELS.indexOf(u);
const ALIAS = { 'security': 'Security & Legal', 'legal': 'Security & Legal', 'security and legal': 'Security & Legal',
  'security & legal': 'Security & Legal', 'security&legal': 'Security & Legal', 'security/legal': 'Security & Legal' };
const LLM_FLAGS = new Set(['spam', 'test', 'phishing', 'fake_urgency', 'injection_attempt']);
const INCIDENT_KW = [['stripe', /stripe/i], ['paypal', /paypal/i], ['checkout', /checkout/i],
  ['whitescreen', /white screen|blank (white )?(screen|page)/i], ['login', /\b(log ?in|sign ?in|connexion)\b/i], ['outage', /\boutage\b|\bis down\b|\bare down\b/i]];
const INCIDENT_WINDOW_MIN = 120;
// A message is only split across two teams when the sender signals a 2nd request ("also", "et aussi", "außerdem", ...).
// The model over-splits otherwise (e.g. one tracking question -> Tech + Billing).
const MULTI_MARKER = /\b(also|as well|and another|on another note|et aussi|aussi|de plus|en plus|además|ademas|también|tambien|außerdem|ausserdem|zusätzlich|zusaetzlich|inoltre|anche|e inoltre|p\.?s\.?)\b|وأيضا|أيضا|كذلك/i;

const base = $('Prep').all().map(i => i.json);
const llm = $input.all().map(i => i.json || {});
let existing = [];
try { existing = $('Read existing').all().map(i => i.json).filter(r => r && r.message_id); } catch (e) {}

const asDate = s => new Date(String(s).replace(' ', 'T') + ':00Z');
const minutes = (a, b) => Math.abs(asDate(a) - asDate(b)) / 6e4;
const dayDiff = (a, b) => Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 864e5);
const closedStatus = s => /^(closed|resolved)/i.test(String(s || ''));

// ---------- tolerant LLM output reading ----------
function extractText(j) {
  if (j.error) return '';
  if (j.teams || j.team) return JSON.stringify(j);                       // node already parsed it
  const c = [j.text, j.output, j.response, j.content, j.message && j.message.content,
    j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content,
    Array.isArray(j.output) && j.output[0] && j.output[0].content && j.output[0].content[0] && j.output[0].content[0].text,
    Array.isArray(j.content) && j.content[0] && j.content[0].text];
  for (const x of c) if (typeof x === 'string' && x.includes('{')) return x;
  return '';
}
function parseJSON(t) {
  if (!t) return null;
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
}
function cleanTeams(v) {
  const arr = Array.isArray(v) ? v : (v ? [v] : []);
  const out = [];
  for (const x of arr) {
    const k = String(x).trim().toLowerCase();
    const t = ALIAS[k] || TEAMS.find(T => T.toLowerCase() === k);
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 2);
}
const validDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z'));

// ---------- history = rows already stored + rows produced in this run ----------
const history = existing.map(r => ({
  message_id: String(r.message_id), sender_key: r.sender_key, team: r.team, received_at: String(r.received_at || ''),
  incident_id: r.incident_id || '', status: r.status || '', urgency: r.urgency || '' }));

const rows = [];
base.forEach((b, i) => {
  const flags = new Set(b.flags);
  let res = parseJSON(extractText(llm[i] || {}));
  let by = 'llm';
  let teams = res ? cleanTeams(res.teams || res.team) : [];
  if (teams.length > 1 && !MULTI_MARKER.test(b.message)) teams = teams.slice(0, 1);   // no 2nd-request marker -> keep the main team only
  let urgency = res && LEVELS.includes(String(res.urgency).toLowerCase()) ? String(res.urgency).toLowerCase() : null;

  if (flags.has('empty_message')) {                                      // nothing to classify
    res = {}; teams = ['Support']; urgency = 'low'; by = 'rules'; flags.add('needs_triage');
  } else if (!res || !teams.length) {                                    // bad / missing LLM answer -> safe fallback
    res = res || {}; teams = ['Support']; urgency = 'normal'; by = 'fallback'; flags.add('needs_triage');
  } else if (!urgency) { urgency = 'normal'; flags.add('needs_triage'); }

  const rawConf = Number(res.confidence);
  const confidence = Number.isFinite(rawConf) ? Math.max(0, Math.min(1, rawConf)) : 0;
  if (by === 'llm' && rawConf > 0 && rawConf < 0.5) flags.add('needs_triage');   // 0 / missing = no signal, not "unsure"
  if (Array.isArray(res.flags)) res.flags.forEach(f => { f = String(f).toLowerCase(); if (LLM_FLAGS.has(f)) flags.add(f); });
  const language = (String(res.language || '').toLowerCase().match(/^[a-z]{2}/) || ['und'])[0];
  const summary = String(res.summary_en || b.message.replace(/\s+/g, ' ').slice(0, 140)).slice(0, 300);
  const need = String(res.customer_need || '').slice(0, 300);
  let deadline = validDay(res.deadline) ? res.deadline : '';

  // --- guardrail 1: prompt injection can never raise urgency
  if (flags.has('injection_attempt') && !flags.has('phishing') && lvl(urgency) > lvl('normal')) { urgency = 'normal'; flags.add('needs_triage'); }
  // --- guardrail 2: spam / test / duplicates are closed automatically
  // (phishing always wins over spam/test: a credential-theft attempt must reach Security, never be silently closed)
  const auto = flags.has('duplicate_submission') || ((flags.has('spam') || flags.has('test')) && !flags.has('phishing'));
  if (auto) urgency = 'low';
  if (!auto) {
    // --- guardrail 3: phishing / impersonation -> Security & Legal, critical
    if (flags.has('phishing')) { teams = ['Security & Legal', ...teams.filter(t => t !== 'Security & Legal')].slice(0, 2); urgency = 'critical'; }
    // --- guardrail 4: deadlines, judged against TODAY
    if (deadline) {
      const d = dayDiff(deadline, TODAY);
      if (d < 0) { flags.add('deadline_passed'); if (lvl(urgency) < 2) urgency = 'high'; }
      else if (d <= 3 && lvl(urgency) < 2) urgency = 'high';
    }
  }
  // --- repeat contact: same sender, same team, earlier message not closed
  const priors = history.filter(h => b.sender_key !== 'unknown' && h.sender_key === b.sender_key && h.received_at <= b.received_at && !closedStatus(h.status));
  const same = priors.filter(h => teams.includes(h.team));
  const sameIds = [...new Set(same.map(h => h.message_id))];
  const priorIds = [...new Set(priors.map(h => h.message_id))];
  const n = sameIds.length + 1;
  if (!auto && priorIds.length) flags.add('repeat_contact');
  if (!auto && n >= 2) urgency = LEVELS[Math.max(lvl(urgency), Math.min(lvl(urgency) + 1, n >= 3 ? 3 : 2))];

  // --- incident grouping: same team + shared keyword + 2h window. Two customers, same problem => critical.
  let incident_id = '', incident_size = '', alert = '';
  const primary = teams[0];
  const closed = auto;
  if (!closed && lvl(urgency) >= lvl('high')) {
    const kws = INCIDENT_KW.filter(([, re]) => re.test(b.message)).map(([k]) => k);
    let found = null;
    if (kws.length) {
      for (const h of history) {
        if (!h.incident_id || h.team !== primary) continue;
        const kw = h.incident_id.split('-').pop();
        if (!kws.includes(kw)) continue;
        const start = history.filter(x => x.incident_id === h.incident_id).map(x => x.received_at).sort()[0];
        if (minutes(b.received_at, start) <= INCIDENT_WINDOW_MIN) { found = h.incident_id; break; }
      }
    }
    if (found) {
      const members = history.filter(x => x.incident_id === found);
      incident_id = found;
      incident_size = new Set(members.map(x => x.message_id)).size + 1;
      flags.add('incident');
      const wasCritical = members.some(x => x.urgency === 'critical');
      if (urgency !== 'critical') urgency = 'critical';
      if (!wasCritical) alert = 'incident_confirmed';                    // 2nd customer: now it's an incident -> alert once
      else if (incident_size === 3) alert = 'incident_update';           // 3rd: one "it's spreading" alert, then quiet
    } else {
      if (kws.length) { incident_id = `INC-${b.received_day}-${kws[0]}`; incident_size = 1; }
      if (urgency === 'critical') alert = 'critical';
    }
  }

  const who = b.sender_name || b.sender_email || 'unknown sender';
  const teamTxt = teams.join(' + ');
  let alert_text = '';
  if (alert === 'critical') alert_text = `🚨 CRITICAL → ${teamTxt}\n${summary}\nFrom: ${who}${b.sender_email ? ' <' + b.sender_email + '>' : ' (no contact info)'}` +
    `${n >= 2 ? `\n🔁 Contact #${n} from this sender` : ''}${incident_id && incident_size === 1 ? `\n🔥 Incident ${incident_id} (first report)` : ''}` +
    `${flags.has('phishing') ? '\n⚠️ Possible phishing / impersonation: do NOT send credentials' : ''}\nReceived: ${b.received_at}`;
  if (alert === 'incident_confirmed') alert_text = `🔥 INCIDENT ${incident_id}: ${incident_size} customers report the same problem → ${teamTxt} (now CRITICAL)\nLatest: ${summary}`;
  if (alert === 'incident_update') alert_text = `🔥 INCIDENT ${incident_id} is spreading: ${incident_size} customers reported the same problem → ${teamTxt}\nLatest: ${summary}`;

  teams.forEach((team, k) => {
    const ticket_id = teams.length > 1 ? `${b.message_id}-${k + 1}` : b.message_id;
    rows.push({
      ticket_id, message_id: b.message_id, external_id: b.external_id,
      received_at: b.received_at, received_day: b.received_day, age_days: dayDiff(TODAY, b.received_day),
      source: b.source, sender_name: b.sender_name, sender_email: b.sender_email, sender_key: b.sender_key,
      message: b.message, language, summary_en: summary, customer_need: need,
      team, urgency, urgency_rank: lvl(urgency), deadline, status: closed ? 'Closed (auto)' : 'New', assignee: '',
      flags: [...flags].join(','), repeat_count: n, prior_ids: priorIds.join(','),
      incident_id, incident_size, needs_triage: flags.has('needs_triage') ? 'yes' : '',
      ai_confidence: confidence, classified_by: by,
      alert: k === 0 ? alert : '', alert_text: k === 0 ? alert_text : '',
      split_from: teams.length > 1 ? b.message_id : '', processed_at: TODAY, notes: '',
    });
    history.push({ message_id: b.message_id, sender_key: b.sender_key, team, received_at: b.received_at,
      incident_id: k === 0 ? incident_id : '', status: closed ? 'Closed (auto)' : 'New', urgency });
  });
});
return rows.map(json => ({ json }));
