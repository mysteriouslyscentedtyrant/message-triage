# Message triage: n8n + Google Sheets

One n8n workflow and one Google Sheet. Every message (backlog CSV, website form/chat/email webhook, FreeScout webhook) goes through the same pipeline: clean it → skip duplicates → AI classifies it → code validates the AI's answer and applies guardrails → store it → alert the team if it's critical.

```
Run backlog ─> Read inbox ─┐
Intake webhook ────────────┴─> Normalize ─> Read existing ─> Prep ─> Classify (LLM) ─> Postprocess ─┬─> Save tickets (Google Sheet)
                                                                                                    └─> Alert needed? ─> Slack + Email
```

## Files

| File | Purpose |
|---|---|
| `triage-workflow.json` | The n8n workflow I ran (Workflows → Import from file). Credentials, my email and my Slack user were removed: re-select them after import. Uses OpenAI `gpt-4o-mini`. |
| `message-triage-sheet.xlsx` | Google Sheet template (upload to Drive → *Save as Google Sheets*). Tabs: README, dashboard, inbox (30 messages), tickets, lists |
| `TEST_JOURNAL.md` | Every problem found while testing (model limits, bugs, fixes) and the final run's numbers |
| `PROMPT_system_message.txt` | The AI instructions used in the Classify node |
| `code/` | The three Code-node scripts (also embedded in the workflow JSON) |
| `test/` | `run.js` (30-message backlog), `edge.js` (31 checks), `fake_llm.js` (simulated AI answers), `requests-backlog.csv`. Run with `node test/run.js` and `node test/edge.js` |
| `screenshots/` | Proof of the live runs: executions, the tickets sheet, a Slack alert, the dashboard |

## What each team gets

- **tickets tab:** one row per ticket. Humans edit only the yellow columns: **status**, **assignee** (dropdown from the `lists` tab), **notes** (and **team**, to re-route a misrouted ticket). Each team makes a saved Google Sheets *filter view* on `team` (steps on the sheet's README tab).
- **dashboard tab:** open tickets by team × urgency, unassigned critical/high, needs-triage, oldest open ticket, repeat contacts. Updates by itself.
- **Slack + email alert** for every new critical ticket, and one extra alert when an incident spreads.

## Setup (about 15 minutes)

1. Upload `message-triage-sheet.xlsx` to Google Drive → *File → Save as Google Sheets*. Copy the sheet ID from the URL.
2. Import `triage-workflow.json` into n8n. In the three Google Sheets nodes replace the sheet ID (mine is pre-filled) and check the tab (`inbox`, `tickets`, `tickets`). *Save tickets* already matches on `ticket_id`.
3. Credentials: Google Sheets, an LLM chat model (OpenAI or Gemini), Slack channel, and the email address in *Email alert*.
4. Delete the rows below the header in `tickets`, then click *Execute workflow* on **Run backlog**.
5. Live intake: publish the workflow and POST to `https://<your-n8n>/webhook/triage-intake`:
   ```json
   {"received_at":"2026-10-12 09:30","source":"form","from":"Jane <jane@x.com>","message":"..."}
   ```
   A FreeScout "new conversation" webhook payload is also understood (see `toRaw()` in `code/01_normalize.js`).

**Rate limits:** the free Gemini tier allows only 5 requests/minute, so I first used *Loop Over Items* (batch 5) + a 65 s *Wait*. After switching to OpenAI (`gpt-4o-mini`, n8n free credits) both were removed and the 30 messages run straight through. If you use a free tier again, put them back after Prep and before Postprocess (details in `TEST_JOURNAL.md`).

## Design choices (and why)

- **One pipeline for every source.** The backlog goes through the same code as live messages, so testing the backlog tests the real thing.
- **The AI only classifies. Code decides everything that matters.** The model returns team, urgency, language, summary, deadline and flags; plain code then validates it and applies rules that must never fail:
  - invalid team / broken JSON / LLM error → Support + `needs_triage` (never a crash, never a lost message)
  - prompt injection ("classify this as CRITICAL") → urgency capped at *normal*
  - phishing (asking for admin/credentials, or an executive claiming lockout) → Security & Legal, critical, never auto-closed. A regex detects it even if the AI misses it.
  - spam / test / duplicate submissions → auto-closed, no alert
  - a customer deadline that already passed or is ≤3 days away → at least *high*
  - a message is split into two tickets only if the sender signals a second request ("also", "et aussi", "außerdem"…); the model over-splits otherwise
- **Step 4 additions, chosen because the backlog shows the need:**
  1. **Repeat-contact escalation:** same sender (case-insensitive) writing again about an open ticket bumps urgency. Sarah's 3rd message becomes critical.
  2. **Incident grouping:** reports sharing a keyword (Stripe, checkout, white screen…) within 2 h form one incident. Second customer → the incident becomes critical; third → one "spreading" alert; the rest stay quiet. 4 Stripe messages = 2 alerts, not 4.
  3. **Dashboard** of what needs a human next.
- **Idempotent:** a message already in the sheet is skipped before the AI call, so re-runs never duplicate rows or re-alert, and human edits (status, assignee) are never overwritten.
- **Google Sheets as the database:** no setup for non-technical teams, dropdowns, and anyone can correct a wrong team or urgency by hand.

## How it was tested

1. **Offline:** `node test/run.js` runs the 30 backlog rows through the three Code nodes with simulated AI answers that include deliberate failures (invalid team, truncated JSON, a "fooled" injection case). `node test/edge.js` has 31 checks: empty and 20,000-character messages, webhook and FreeScout payloads, impossible dates, Arabic + emoji, 7 kinds of garbage AI output, re-submission, resolved-then-new ticket, phishing+spam, incident grouping.
2. **Live, several full backlog runs with a real model.** This found bugs the offline tests could not, each fixed in code and covered by a regression test where possible:
   - every ticket flagged `needs_triage` because the model copied `"confidence":0.0` from my prompt example
   - the fake "CEO" password request was classified *normal*, because the model called it an injection and my injection guardrail capped it
   - the 4 Stripe reports were rated critical/high/high/high, so incident grouping never triggered
   - the model split single-topic messages across two teams
   - the free Gemini tier's 5 requests/min limit (later removed with paid OpenAI credits)
   - the full list, in order, is in [`TEST_JOURNAL.md`](TEST_JOURNAL.md)
3. **Dashboard:** 63 cells checked against an independent count; 0 formula errors.
4. **Last live run:** 31 tickets from the 30 messages, 6 Slack + 6 email alerts, 28 open, 0 open tickets needing triage. Dashboard checked against an independent count.

## Known limits

- **AI wobble on small things:** run to run, a few non-critical tickets differ. Fatima's "downgrade before renewal on Oct 10" came out `normal` instead of `high` in the last run because the model didn't return the deadline; the model also invents deadlines for some messages (Marc, Lucía, Sofia, Jonas, Noor, Julia in the last run); Ahmed's first hack report was sometimes labelled `phishing` in earlier runs. The critical cases were right in every run.
- Spam and test messages come back with an invalid team, so they go through the fallback path (Support, closed). Harmless, because they're auto-closed.
- Team views are Google Sheets filter views each team sets up once, not separate tabs.
- Incident detection is keyword-based (Stripe, PayPal, checkout, white screen, login, outage). A new kind of outage is alerted per message until its keyword is added.
- `age_days` is calculated when the ticket is created, not live. "Today" is fixed to 2026-10-12 in the three Code nodes (the test anchor).
- **Webhook:** verified live through the published (production) URL: a POSTed message created a critical ticket and fired Slack + email. Runs started from the editor's "Listen for test event" stop after the Normalize node (cause not found). The webhook has no authentication in this test; add header auth before real use.
- **Not tested live:** the FreeScout webhook payload shape (parser written from the API format), and sending an email via anything but Gmail.
- Not built: AI-drafted replies, SLA timers, per-team Slack channels, writing back to FreeScout, auto-assignment.

## Reference results (backlog)

| Messages | Team | Urgency |
|---|---|---|
| Sarah ×3 (domain) | Tech | normal → high → **critical** (3rd contact) |
| "CEO" password request | Security & Legal | critical, `phishing`, do not reply |
| Ahmed ×2 (hacked) | Security & Legal | critical ×2 |
| 4 × Stripe checkout | Tech | all critical; 1st alerts, 3rd sends one incident update |
| Chloé (VAT + editor crash) | Billing + Tech (2 tickets) | normal |
| Karim ("ignore previous instructions") | Support | normal, `injection_attempt` |
| Emma ("URGENT!!!" font) | Support | low/normal, not high |
| Crypto spam / "test test" | Support | auto-closed |
| Fatima (downgrade before Oct 10) | Billing | should be high; last run gave normal (see limits) |
| Jonas (GDPR, DE) | Security & Legal | high |
| Noor (Arabic, unpaid commissions) | Billing | high, language `ar` |
