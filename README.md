# Playroom Nearby SEO Bot

Long-running TypeScript service that treats the [Playroom SEO spreadsheet](https://docs.google.com/spreadsheets/d/10QigScXswOt9QUns059V5PWqc29aOul74UwNoUGSeAM/edit) as its control plane:

```text
keywords → text + image → QA pass → Telegram review → approval/48h timeout → 10:00 → Ghost
                         ↘ QA fail → one automatic repair ↗
                                      ↘ failed_qa → manual /regenerate; no auto-publish
```

The service is safe by default. It will not write to Ghost in any environment unless all of these are true:

- `DRY_RUN=false` in the server environment;
- `ALLOW_GHOST_PUBLISH=true` in the server environment;
- `publication_enabled=true` in the Sheet.

Production additionally requires both `security_ready=true` and
`technical_seo_ready=true`. Staging is the acceptance environment and does not
pretend those production attestations are complete.

## Implemented

- Dynamic Google Sheets header mapping and schema checks; no hard-coded column numbers.
- A minimal Telegram review flow with comment-first rewriting and approval of the sole active article.
- Equal approval rights for any human member of the configured review group.
- Approval bound to a SHA-256 hash of all publishable fields.
- Manual edits after approval stop publication with `status=conflict`.
- Deterministic QA for locale, title, slug, metadata, sources, allow-listed internal links, manual blockers, and score. A failed first draft is not shown as a review card: the bot shows one plain-language progress message and makes exactly one automatic repair attempt. A repaired draft must pass QA before its card is delivered; an exhausted repair is stored as `failed_qa` and cannot be auto-published.
- Ghost 5.x JWT authentication, localized slugs (`-en`, `-rs`), HTML sanitization, draft-first upsert, optimistic `updated_at` lock, and public-page verification.
- A durable Telegram publication outcome: after Ghost and the public page are verified, the review group receives the canonical article link exactly once per publication event; failures receive an actionable Sheet link instead.
- OpenAI Responses API generation with web research and strict structured output. The OpenAI clients for article and image generation use `maxRetries=0`, so an ambiguous network/provider failure cannot silently become another paid request.
- A versioned Playroom hero-image pipeline using `gpt-image-2`: one topic-specific orange/yellow landscape WebP is generated before review, uploaded to Ghost, and attached as `feature_image` with localized alt text. The binary and upload result are cached durably, while missing/broken image data fails publication closed.
- Append-only audit events, single-process per-article locking, health endpoints, Docker build, and unit tests.
- Recovery for stale `publishing` claims, including reconciliation when Ghost was updated before a process crash.
- Durable Monday/Friday editorial slots at 10:00 Europe/Belgrade. Each slot generates at most one article; an empty queue produces one actionable Telegram warning with the exact `keywords` link.
- A 48-hour review SLA measured only from a QA-passing review card. Repair progress and exhausted-repair notices are not review cards and start no timer. If no one approves or regenerates a valid card, a trusted system approval schedules it for the first 10:00 after the deadline; QA failure still stops publication.

## Telegram commands

- `/generate`
- `/regenerate editor feedback`
- `/approve`
- `/help`

Only one article can be in generation, automatic repair, or manual review at a time. While it remains active, another `/generate` is rejected with a pointer to the existing work. `/regenerate editor feedback` immediately rewrites that sole active draft, and bare `/approve` approves it only after QA passes; sending either command as a direct reply selects the visible bot message explicitly. Editor feedback is mandatory for regeneration, while `/approve` accepts no arguments. There is no ARTICLE-ID fallback or inline action keyboard. Regeneration replaces the same row only after OpenAI succeeds, keeps the old draft on failure, increments `revision_count`, and never reopens an approved or published article. Workflow commands from private chats or groups other than the configured review group are rejected. `/help` explains the three available actions.

With `EDITORIAL_AUTOMATION_ENABLED=true`, durable weekly slots replace the legacy continuously-polled scheduled generator. Defaults are Monday and Friday (`1,5`) at `10:00` in `Europe/Belgrade`. A missed slot is caught up after restart, and an unresolved review keeps the slot pending instead of creating a second card. Completion is recorded in the append-only `events` sheet, so ordinary polls and restarts do not repeat it.

The VPS runs one combined background cycle per minute to stay within Google Sheets per-user read quotas. Telegram acknowledges commands immediately; queued generation, publication and final-link delivery can begin on the next cycle.

The review timer starts only after Telegram accepts a QA-passing card and its message ID/timestamp are stored in the article row. An automatic-repair progress message does not start it. A successful manual `/regenerate` is rechecked; only its delivered passing card starts a fresh 48-hour window. Manual approvals and timeout approvals both publish at 10:00 local: manual approval chooses the next available 10:00, while timeout approval chooses the first 10:00 after the 48-hour deadline. The approved hash includes that exact schedule. Timeout approval is a narrowly trusted `system:auto-review-timeout` audit event.

The publisher accepts ordinary polling delay for 15 minutes after 10:00. If a VPS outage misses that bounded window, an already scheduled article is atomically moved to the next future `publication_time`; a `publication_rescheduled` audit event carries the newly authorized content hash. It is never published immediately at an arbitrary restart time. The optional Sheet setting `publication_grace_minutes` can tune the grace from 1 to a hard maximum of 60 minutes.

`/generate` accepts no arguments. It reserves the physically topmost row on `keywords` whose status is `ready`; row order is the manual priority, so the numeric `priority` value is ignored for this dequeue. Keyword, locale, and content settings come from that existing row. A malformed top row is never skipped silently: Telegram names the row and invalid fields and links directly to the relevant Sheet range. After OpenAI returns an article, the keyword becomes `used`. If QA passes, the bot delivers the only review card. If QA fails, it withholds the card, shows one progress message without raw blocker codes, and spends at most one automatic editorial repair attempt. A passing repair produces the card and starts a new 48-hour window; otherwise the row becomes `failed_qa`, stays blocked from timeout publication, and the same Telegram message becomes a friendly instruction to edit the linked Sheet row and send `/regenerate your feedback`. A technical article or image generation failure instead moves the keyword to `paused`; neither application orchestration nor the OpenAI SDK repeats an ambiguous paid request automatically. Manual generation requires both `ALLOW_TELEGRAM_GENERATION=true` in the server environment and `telegram_generation_enabled=true` in the Sheet. Scheduled generation remains independently controlled by `generation_enabled`, but the same single-active-article gate prevents it from producing a second article. Any arguments passed to `/generate` are rejected.

## Configuration

Copy `.env.example` to an ignored `.env.local` for local development. Never put credentials in the spreadsheet.

Required secrets:

- `TELEGRAM_BOT_TOKEN`
- `GHOST_ADMIN_API_KEY`
- either `GOOGLE_APPLICATION_CREDENTIALS` or `GOOGLE_SERVICE_ACCOUNT_JSON`
- `OPENAI_API_KEY` to enable generation

Article and image generation share `OPENAI_API_KEY`. Image defaults are intentionally explicit and may be overridden without changing code:

```dotenv
OPENAI_IMAGE_MODEL=gpt-image-2
OPENAI_IMAGE_SIZE=1536x1024
OPENAI_IMAGE_QUALITY=high
HERO_IMAGE_CACHE_DIR=/app/data/hero-images
```

Both OpenAI SDK clients are configured with `maxRetries=0`. One automatic QA repair is an explicit, separately audited editorial attempt; SDK/network retries are not part of that budget. If a paid request has an ambiguous technical outcome, the bot fails closed instead of silently issuing it again.

`OPENAI_IMAGE_SIZE` must be a valid landscape GPT Image resolution. Mount `HERO_IMAGE_CACHE_DIR` on persistent storage in Docker. Without that volume, a container replacement can repeat a paid generation; with it, generation and the returned Ghost URL survive restarts. The canonical visual rules and hard safety constraints live in [prompts/HERO_IMAGE_GUIDE.md](prompts/HERO_IMAGE_GUIDE.md). Do not edit them without incrementing the prompt version in code.

The Google service account must be explicitly shared onto the spreadsheet as an editor. The Google authorization used interactively in Codex cannot be reused by the deployed process.

Editorial server defaults are configured with:

```dotenv
EDITORIAL_AUTOMATION_ENABLED=true
EDITORIAL_TIME_ZONE=Europe/Belgrade
EDITORIAL_RUN_DAYS=1,5
EDITORIAL_RUN_TIME=10:00
AUTO_PUBLISH_AFTER_REVIEW=true
REVIEW_DEADLINE_HOURS=48
PUBLICATION_TIME=10:00
```

The Sheet can override these without a redeploy through `editorial_automation_enabled`, `editorial_run_days`, `editorial_run_time`, `auto_publish_after_review`, `review_deadline_hours`, and `publication_time` in `settings`. For compatibility, `auto_publish_without_approval` and `review_window_hours` are used when their newer aliases are absent. The existing `generation_enabled` and publication gates remain absolute switches. Weekdays use `0=Sunday ... 6=Saturday`.

The configured Ghost URL is the instance root, not the raw API path. Production uses
`https://playroom-kids.app/internal`; staging uses the example below:

```dotenv
GHOST_ADMIN_URL=https://beaver.run.place/internal
GHOST_API_VERSION=v5.0
```

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

`scripts/install-windows.ps1` is retained only for isolated local development. Do not run the
Windows tray instance with the production Telegram token: production has exactly one long-poller
in the VPS container.

Health endpoints:

- `GET /healthz` — process is alive.
- `GET /readyz` — Sheets schema, Ghost auth, and Telegram auth all passed startup checks.

## Deployment

Run exactly one replica. Telegram long polling and the current in-process locks assume a single writer. The production VPS recipe is in [deploy/vps/README.md](deploy/vps/README.md): it creates one private Docker network, publishes no port, applies CPU/memory/PID/security limits, persists `/app/data/hero-images`, rotates logs, and installs a watchdog scoped only to `playroom-seo-bot`.

The current `/internal/` Ghost is not truly private: public Ghost pages, sitemap, and RSS are reachable even though `robots.txt` disallows crawling. Keep `technical_seo_ready=false` until canonical, hreflang, RU routing, and exposure decisions are resolved.

See [docs/ROADMAP.md](docs/ROADMAP.md) for the implementation and launch backlog, and
[docs/OPERATOR_GUIDE_RU.md](docs/OPERATOR_GUIDE_RU.md) for the owner workflow and client handoff.
