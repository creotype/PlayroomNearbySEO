# Roadmap and launch backlog

## P0 — working control plane

- [x] Replace the inherited WordPress-oriented Sheet with the Playroom workflow.
- [x] Define article, keyword, guardrail, link, settings, event, and future social-post tables.
- [x] Add editor/system field separation, validation, filters, conditional formatting, and safe starter values.
- [x] Validate Telegram bot and Ghost Admin credentials without content mutation.
- [x] Implement Sheets, Telegram, Ghost, generation, QA, audit, and scheduler modules.
- [x] Make argument-free `/generate` reserve the topmost `ready` keyword by physical row order, using that row's locale and content settings.
- [x] Mark the reserved keyword `used` after generation even when QA fails; pause it only on a technical generation failure.
- [x] Withhold a QA-failing draft from review, show one blocker-free progress message, and run exactly one durable automatic repair attempt; deliver a card only after QA passes, otherwise fail closed as `failed_qa` with a manual `/regenerate` instruction and Sheet-row link.
- [x] Disable OpenAI SDK retries (`maxRetries=0`) for both article and image clients so ambiguous paid technical requests are not repeated.
- [x] Enforce dry-run and hash-bound human approval.
- [x] Create a Google Cloud service account, share its email onto the Sheet, and prepare its JSON credential for the server.
- [x] Capture the Telegram review-group ID and store the non-secret ID in `settings.telegram_chat_id`.
- [x] Configure an OpenAI API key and confirm article and image model access.

## P0 — staging acceptance

- [ ] Fix or explicitly accept the public exposure of `/internal/` sitemap, RSS, and post pages.
- [ ] Correct blog-index canonical URLs for `/en/blog`, `/rs/blog`, and `/ru/blog`.
- [ ] Complete hreflang routing; leave RU disabled until it is valid.
- [ ] Populate `link_inventory` with production/staging URLs that have `status=active` and `allow_internal_link=true`.
- [ ] Restrict spreadsheet editor access to named collaborators.
- [ ] Run service startup probes with `DRY_RUN=true`.
- [ ] Put two disposable keywords in `ready`, confirm `/generate` rejects arguments and dequeues the physically topmost row regardless of numeric `priority`.
- [ ] Confirm generated keywords become `used` on both QA pass and QA failure, while a technical article/image generation failure becomes `paused` without an application or SDK retry.
- [ ] Force initial QA failure and verify there is no review card or 48-hour timer yet: Telegram shows one progress message without raw blocker codes and exactly one automatic repair is recorded across polls/restarts.
- [ ] Verify both repair outcomes: QA pass yields one card with a fresh 48-hour window; exhaustion yields `failed_qa`, a friendly `/regenerate` + Sheet link, and no timeout approval/publication.
- [ ] Verify the single-active-article gate, button-free Telegram card, no-reply `/regenerate` and `/approve`, manual Sheet edit, repeated QA, and approval idempotency.
- [ ] Allow Ghost writes while keeping public publishing disabled; create one draft and verify the ID/update lock.
- [ ] Perform one explicitly approved end-to-end staging publication and canonical check.

## P1 — production launch

- [x] Set production frontend base URL and production Ghost target.
- [x] Implement durable Monday/Friday 10:00 Europe/Belgrade generation slots with an actionable empty-queue warning.
- [x] Enforce a 48-hour card-based review SLA and schedule human/timeout approvals for 10:00 local.
- [x] Fail QA closed before review: one automatic repair at most, then `failed_qa` with manual recovery and no auto-publication.
- [x] Deploy one isolated Docker replica on the shared VPS with restart policy, bounded logs, `/readyz` monitoring, and a narrowly scoped health watchdog.
- [ ] Add daily recovery for stale `generating`/`publishing` rows.
- [x] Turn on `security_ready`, then `technical_seo_ready`, then generation; enable publication last.
- [ ] Review the first ten posts manually and tune prompts/QA thresholds from observed failures.

## P2 — follow-up automation

- [ ] Social-post generation from published articles.
- [x] Automatic feature-image generation and Ghost asset upload.
- [ ] Search Console indexing/coverage feedback.
- [ ] Rank and traffic feedback into keyword priorities.
- [ ] Multiple approver roles, deadlines, reminders, and escalation.
- [ ] Multi-replica coordination using a durable queue and distributed locks.
