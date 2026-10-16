// Simulated LLM answers, in CSV row order (1..30). Mostly "ideal", with deliberate failures to test the guardrails.
const r = (teams, urgency, language, summary, extra = {}) => ({
  text: JSON.stringify({ teams, urgency, language, summary_en: summary, customer_need: summary, deadline: null, flags: [], confidence: 0.9, ...extra }),
});
module.exports = [
  /*1 Sarah*/ r(['Tech'], 'normal', 'en', 'Custom domain not connecting after 48h'),
  /*2 Sarah*/ r(['Tech'], 'high', 'en', 'Domain still not working, launch Oct 15', { deadline: '2026-10-15' }),
  /*3 Tom*/ r(['Product'], 'low', 'en', 'Asks for TikTok pixel field'),
  /*4 spam*/ r(['Support'], 'low', 'en', 'Crypto spam', { flags: ['spam'] }),
  /*5 Hannah*/ r(['Migration'], 'high', 'en', 'Migrating 12 courses/900 students from Kajabi', { deadline: '2026-10-20' }),
  /*6 Aisha*/ r(['Tech'], 'normal', 'en', 'Affiliate link shows 0 clicks'),
  /*7 Julia*/ { text: '```json\n' + JSON.stringify({ teams: ['Billing'], urgency: 'high', language: 'it', summary_en: 'Double charge on annual plan, threatens chargeback', customer_need: 'refund', deadline: null, flags: [], confidence: 0.92 }) + '\n```' },
  /*8 nosender*/ r(['Tech'], 'high', 'en', 'Funnel pages blank white screen since this morning'),
  /*9 Diego*/ r(['Sales'], 'low', 'es', 'Wants dark mode'), // INVALID TEAM -> fallback
  /*10 Emma*/ r(['Support'], 'normal', 'en', 'How to change headline font', { flags: ['fake_urgency'] }),
  /*11 Priya*/ r(['Deliverability'], 'high', 'en', 'Emails land in Gmail spam, open rate 40%->6%'),
  /*12 Fatima*/ r(['Billing'], 'normal', 'en', 'Wants downgrade before renewal on Oct 10', { deadline: '2026-10-10' }),
  /*13 Jonas*/ r(['Security & Legal'], 'high', 'de', 'GDPR Art.17 erasure request'),
  /*14 Sarah*/ r(['Tech'], 'high', 'en', '3rd contact: domain broken, launch in 6 days', { deadline: '2026-10-15' }),
  /*15 CEO*/ r(['Security & Legal'], 'high', 'en', 'Sender claims to be CEO asking for admin password', { flags: ['phishing'] }),
  /*16 Olivier*/ r(['Deliverability'], 'normal', 'fr', 'DKIM stays unverified for 3 days'),
  /*17 Noor*/ r(['Billing'], 'high', 'ar', 'Affiliate commissions unpaid for 2 months'),
  /*18 Leo*/ r(['Support'], 'low', 'de', 'How to set drip content schedule'),
  /*19 Ahmed*/ r(['Security & Legal'], 'critical', 'en', 'Account hacked, payout email changed'),
  /*20 Lina*/ r(['Migration'], 'normal', 'en', 'Wants to move Kartra funnels'),
  /*21 Chloe*/ r(['Billing', 'Tech'], 'normal', 'fr', 'Invoice missing VAT number + editor crashes when adding video'),
  /*22 Tom*/ r(['Product'], 'high', 'en', 'TikTok ads start Monday, needs tracking workaround', { deadline: '2026-10-12' }),
  /*23 Paul*/ r(['Support'], 'low', 'en', 'Test message', { flags: ['test'] }),
  /*24 Karim*/ r(['Support'], 'critical', 'en', 'Coupon on order form (model was fooled)'), // FOOLED -> must be capped
  /*25 Marc*/ r(['Tech'], 'critical', 'fr', 'Stripe checkout error since 18h'),
  /*26 Lucia*/ r(['Tech'], 'critical', 'es', 'Stripe payment failing for an hour'),
  /*27 Ben*/ r(['Tech'], 'critical', 'en', 'Stripe checkout failing, PayPal fine'),
  /*28 Sofia*/ { text: '{"teams":["Tech"],"urgency":"critical","language":"en","summary_en":"Stripe checkout down for an hour"' }, // MALFORMED JSON -> fallback
  /*29 Yuki*/ r(['Billing'], 'normal', 'en', 'Cancel + refund request'),
  /*30 Ahmed*/ r(['Security & Legal'], 'critical', 'en', 'No answer on hacked account, payout tomorrow'),
];
