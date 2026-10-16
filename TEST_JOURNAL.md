# Testing journal

What went wrong while building this, in the order it was found, and what I did about it. Most problems came from the AI model and its limits, not from the logic around it, which is why the AI only classifies and plain code makes the decisions.

## Phase 1: offline (no AI)

`node test/run.js` runs the 30 backlog messages through the three Code nodes with simulated AI answers, including deliberate failures (invalid team, truncated JSON, a "fooled" injection case). `node test/edge.js` has 31 checks. All pass. This proved the logic, but it can't prove the real model behaves, so the real tests came next.

## Phase 2: getting a model to run

| # | What happened | What I did |
|---|---|---|
| 1 | I wanted Claude as the classifier, but a Claude subscription doesn't include API access (the API is billed separately). | Used a free option instead. |
| 2 | Gemini free tier: HTTP 429 after 5 requests per minute. | Added *Loop Over Items* (batch of 5) + a 65 s *Wait* after the AI step. |
| 3 | Switched to OpenAI (`gpt-4o-mini`) on n8n's free credits. | *Wait* reduced to 1 s. |
| 4 | With credits available, the loop and wait were no longer needed. | **Removed both.** The final run sends all 30 messages straight through Prep → Classify → Postprocess. |

## Phase 3: bugs in my own setup

| # | What happened | Fix |
|---|---|---|
| 5 | Every ticket landed in *Support* with `needs_triage`: the AI never ran. Cause: the system-message type in my generated workflow was invalid ("Invalid message type"). | Set the type to System and corrected the generator. Side benefit: this was a real test of the fallback path. Nothing crashed and no message was lost. |
| 6 | Second run produced "No output data": old rows in `tickets` made Prep skip every message as "already stored". | Working as designed (re-runs never duplicate). The rows must be cleared before a fresh test. |
| 7 | *Save tickets* error: `columns.matchingColumns is required`. | Match on `ticket_id`. |
| 8 | I wired the loop wrongly (Classify straight to Postprocess). | Rewired. (The loop has since been removed.) |
| 9 | *Email alert*: "Invalid email address" (placeholder left in). | Set a real address. |
| 10 | Reviewing the exported workflow, I found `sender_email` was mapped to `sender_name` in *Save tickets*, so the column held names. | Fixed the mapping, cleared the sheet and re-ran. The column now holds real addresses. |

## Phase 4: the model's behaviour (found only by live runs)

| # | What happened | Fix |
|---|---|---|
| 11 | Every ticket flagged `needs_triage`: the model copied `"confidence": 0.0` from my prompt example. | Example changed to 0.9; code treats 0 as "no signal", not "unsure". |
| 12 | The fake "CEO asks for the admin password" message was rated *normal* and raised no alert. The model called it an injection and my own injection guardrail capped it. | Regex phishing detector in code (independent of the AI). Phishing beats the injection cap and is never auto-closed, even if also tagged spam. |
| 13 | The 4 Stripe reports were rated critical/high/high/high, so incident grouping never triggered. | Prompt says failing payments are critical, and code escalates the second report of an incident to critical. |
| 14 | The model split single-topic messages across two teams (Aisha, Sarah #2, Ahmed #2). | Code only allows two tickets when the sender signals a second request ("also", "et aussi", "außerdem"…). Chloé's real two-topic message still splits. |
| 15 | Spam and "test" messages sometimes come back with an invalid team. | They go through the fallback path and are closed automatically anyway. |
| 16 | The model invents deadlines even though the prompt says never to, and sometimes misses real ones. In the last run it gave deadlines to Marc, Lucía, Sofia, Jonas, Noor and Julia, and none to Fatima ("renewal on Oct 10"), so her ticket is *normal* instead of *high*. | Not fixed. The affected tickets still ended up high or critical, as their content warrants, but Fatima's is wrong. It's the main known flaw. |

## Phase 5: webhook

| # | What happened | Note |
|---|---|---|
| 17 | Runs started from the editor's "Listen for test event" stop after the *Normalize* node. | Cause not found. The published (production) URL runs the whole workflow, and that is the path I verified. |
| 18 | The webhook has no authentication. | Fine for a test, not for real use. Header auth would be the first hardening step. |

## Final live run (30 backlog messages, no loop)

- 31 tickets from 30 messages (Chloé's is split into Billing + Tech).
- 6 Slack and 6 email alerts: Sarah's 3rd message, the fake CEO, Ahmed twice, the first Stripe report, and one "incident is spreading" alert for the third Stripe report.
- 28 tickets open, 3 closed (2 auto-closed spam/test, 1 resolved by hand). 8 critical, 7 high, 0 open tickets needing triage.
- Dashboard numbers match an independent count of the sheet rows for every team.

| Team | critical | high | normal | low | open |
|---|---|---|---|---|---|
| Support | 0 | 0 | 3 | 0 | 3 |
| Tech | 5 | 3 | 3 | 0 | 11 |
| Billing | 0 | 2 | 3 | 0 | 5 |
| Deliverability | 0 | 1 | 1 | 0 | 2 |
| Migration | 0 | 0 | 1 | 0 | 1 |
| Product | 0 | 0 | 0 | 2 | 2 |
| Security & Legal | 3 | 1 | 0 | 0 | 4 |
