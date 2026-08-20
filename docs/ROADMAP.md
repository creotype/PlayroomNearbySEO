# Roadmap and launch backlog

## P0 — working control plane

- [x] Replace the inherited WordPress-oriented Sheet with the Playroom workflow.
- [x] Define article, keyword, guardrail, link, settings, event, and future social-post tables.
- [x] Add editor/system field separation, validation, filters, conditional formatting, and safe starter values.
- [x] Validate Telegram bot and Ghost Admin credentials without content mutation.
- [x] Implement Sheets, Telegram, Ghost, generation, QA, audit, and scheduler modules.
- [x] Make argument-free `/generate` reserve the topmost `ready` keyword by physical row order, using that row's locale and content settings.
- [x] Mark the reserved keyword `used` after generation even when QA fails; pause it only on a technical generation failure.
- [x] Enforce dry-run and hash-bound human approval.
- [ ] Create a Google Cloud service account, share its email onto the Sheet, and mount its JSON credential on the server.
- [ ] Capture the Telegram review-group ID and store the non-secret ID in `settings.telegram_chat_id`.
- [ ] Configure an OpenAI API key and confirm the allowed model.

## P0 — staging acceptance

- [ ] Fix or explicitly accept the public exposure of `/internal/` sitemap, RSS, and post pages.
- [ ] Correct blog-index canonical URLs for `/en/blog`, `/rs/blog`, and `/ru/blog`.
- [ ] Complete hreflang routing; leave RU disabled until it is valid.
- [ ] Populate `link_inventory` with production/staging URLs that have `status=active` and `allow_internal_link=true`.
- [ ] Restrict spreadsheet editor access to named collaborators.
- [ ] Run service startup probes with `DRY_RUN=true`.
- [ ] Put two disposable keywords in `ready`, confirm `/generate` rejects arguments and dequeues the physically topmost row regardless of numeric `priority`.
- [ ] Confirm generated keywords become `used` on both QA pass and QA failure, while a technical generation failure becomes `paused` without automatic retry.
- [ ] Verify the single-active-article gate, button-free Telegram card, no-reply `/regenerate`, reply-only `/approve`, manual Sheet edit, repeated QA, and approval idempotency.
- [ ] Allow Ghost writes while keeping public publishing disabled; create one draft and verify the ID/update lock.
- [ ] Perform one explicitly approved end-to-end staging publication and canonical check.

## P1 — production launch

- [ ] Set production frontend base URL and production Ghost target.
- [ ] Choose generation cadence and fill `generation_cron`.
- [ ] Set publication windows and owner review SLA.
- [ ] Deploy one Docker replica with restart policy, logs, and `/readyz` monitoring.
- [ ] Add daily recovery for stale `generating`/`publishing` rows.
- [ ] Turn on `security_ready`, then `technical_seo_ready`, then generation; enable publication last.
- [ ] Review the first ten posts manually and tune prompts/QA thresholds from observed failures.

## P2 — follow-up automation

- [ ] Social-post generation from published articles.
- [ ] Automatic feature-image generation and Ghost asset upload.
- [ ] Search Console indexing/coverage feedback.
- [ ] Rank and traffic feedback into keyword priorities.
- [ ] Multiple approver roles, deadlines, reminders, and escalation.
- [ ] Multi-replica coordination using a durable queue and distributed locks.
