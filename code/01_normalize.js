// n8n Code node  |  name it exactly: Normalize  |  Mode: Run Once for All Items
// Input : raw messages {received_at, source, from, message} from the CSV/Sheet, a webhook body, or a FreeScout payload
// Output: one clean item per message (parsed date, parsed sender, stable id, injection flag)

const TODAY = '2026-10-12';          // test anchor ("today" = Monday Oct 12, 2026)
const MAX_LEN = 4000;
const MON = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
const pad = n => String(n).padStart(2, '0');

function validDate(y, m, d, hh = 0, mm = 0) {
  const dt = new Date(Date.UTC(y, m - 1, d, hh, mm));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && hh < 24 && mm < 60;
}

// Returns {iso:'YYYY-MM-DD HH:mm', approx:bool, ok:bool}. Day-first for dd/mm/yyyy (the backlog proves it).
function parseDate(raw) {
  const s = String(raw ?? '').trim();
  let m, y, mo, d, hh, mm, approx = false;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/))) {
    y = +m[1]; mo = +m[2]; d = +m[3]; hh = m[4]; mm = m[5];
  } else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/))) {
    const a = +m[1], b = +m[2];
    if (b > 12 && a <= 12) { mo = a; d = b; } else { d = a; mo = b; }   // fall back to mm/dd only if dd/mm is impossible
    y = +m[3]; hh = m[4]; mm = m[5];
  } else if ((m = s.match(/^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?(?:\s+(\d{1,2}):(\d{2}))?$/))) {
    mo = MON[m[1].toLowerCase()]; d = +m[2];
    if (m[3]) y = +m[3]; else { y = +TODAY.slice(0, 4); approx = true; }
    hh = m[4]; mm = m[5];
  } else return { iso: TODAY + ' 00:00', approx: true, ok: false };
  if (hh === undefined) { approx = true; hh = 0; mm = 0; }
  hh = +hh; mm = +mm;
  if (!mo || !validDate(y, mo, d, hh, mm)) return { iso: TODAY + ' 00:00', approx: true, ok: false };
  return { iso: `${y}-${pad(mo)}-${pad(d)} ${pad(hh)}:${pad(mm)}`, approx, ok: true };
}

function parseSender(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { name: '', email: '', key: 'unknown', flags: ['no_contact'] };
  let name = '', email = s;
  const m = s.match(/^(.*?)<([^>]+)>\s*$/);
  if (m) { name = m[1].replace(/["']/g, '').trim(); email = m[2].trim(); }
  email = email.toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { name, email, key: email, flags: [] };
  return { name: name || s, email: '', key: 'raw:' + s.toLowerCase(), flags: ['invalid_email'] };
}

const strip = h => String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').trim();

// Accepts: plain row | webhook {body:{...}} | FreeScout conversation payload (verify shape with a real test event)
function toRaw(j) {
  if (j && j.body && typeof j.body === 'object' && !Array.isArray(j.body)) j = j.body;
  if (j && (j.customer || (j._embedded && j._embedded.threads))) {
    const c = j.customer || {};
    const th = ((j._embedded || {}).threads || []).filter(t => t.type === 'customer')
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const body = th.length ? strip(th[0].body) : (j.preview || '');
    const fullName = [c.firstName, c.lastName].filter(Boolean).join(' ');
    return { received_at: j.createdAt, source: 'freescout', external_id: String(j.number || j.id || ''),
             from: c.email ? `${fullName} <${c.email}>` : fullName, message: [j.subject, body].filter(Boolean).join('\n') };
  }
  return j || {};
}

// two independent 32-bit FNV-1a hashes -> 16 hex chars (no crypto module needed)
function hash(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0xdeadbeef;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return 'm_' + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

const INJECTION = /(ignore|disregard|forget)\s+(all\s+|any\s+|your\s+|the\s+|previous\s+|prior\s+|above\s+)*(instructions|rules|prompt)|you\s+are\s+now|system\s+prompt|classify\s+(this|it|the message)\s+as|mark\s+(this|it)\s+as\s+(critical|urgent)/i;

// Safety net independent of the AI: asking for admin/staff credentials, or claiming to be an executive and asking for access.
const PHISH = /\b(admin(istrator)?|support( account)?|staff|root)\s+(password|credentials|login|access|account)|\b(i am|i'm|it's|this is)\s+(the\s+)?(ceo|founder|owner|director|boss)\b[^.!?\n]{0,160}\b(password|credentials|login|access|locked out)\b/i;

const out = [];
$input.all().forEach((it, idx) => {
  const r = toRaw(it.json);
  const flags = [];
  const dt = parseDate(r.received_at);
  if (!dt.ok) flags.push('bad_date');
  if (dt.approx) flags.push('approx_date');
  const snd = parseSender(r.from);
  flags.push(...snd.flags);
  let message = String(r.message ?? '').replace(/\r/g, '').trim();
  if (!message) flags.push('empty_message');
  if (message.length > MAX_LEN) { message = message.slice(0, MAX_LEN); flags.push('truncated'); }
  if (INJECTION.test(message)) flags.push('injection_attempt');
  if (PHISH.test(message)) flags.push('phishing');
  const message_norm = message.toLowerCase().replace(/\s+/g, ' ');
  const source = String(r.source || 'unknown').toLowerCase().trim();
  out.push({
    message_id: hash([dt.iso, source, snd.key, message_norm].join('|')),
    external_id: r.external_id || '',
    received_at: dt.iso, received_day: dt.iso.slice(0, 10), source,
    sender_name: snd.name, sender_email: snd.email, sender_key: snd.key,
    message, message_norm, flags, _order: idx,
  });
});
out.sort((a, b) => a.received_at.localeCompare(b.received_at) || a._order - b._order);
return out.map(json => ({ json }));
