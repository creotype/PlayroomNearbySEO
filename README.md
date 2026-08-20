# Playroom Nearby SEO Bot

Long-running TypeScript service that treats the [Playroom SEO spreadsheet](https://docs.google.com/spreadsheets/d/10QigScXswOt9QUns059V5PWqc29aOul74UwNoUGSeAM/edit) as its control plane:

```text
keywords → OpenAI generation/research → articles → Telegram review
/generate ────────────────┘         → /seo_approve → Ghost publish → verify
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
- Telegram group commands and inline approval button.
- Equal approval rights for any human member of the configured review group.
- Approval bound to a SHA-256 hash of all publishable fields.
- Manual edits after approval stop publication with `status=conflict`.
- Deterministic QA for locale, title, slug, metadata, sources, allow-listed internal links, manual blockers, and score.
- Ghost 5.x JWT authentication, localized slugs (`-en`, `-rs`), HTML sanitization, draft-first upsert, optimistic `updated_at` lock, and public-page verification.
- OpenAI Responses API generation with web research and strict structured output.
- Append-only audit events, single-process per-article locking, health endpoints, Docker build, and unit tests.
- Recovery for stale `publishing` claims, including reconciliation when Ghost was updated before a process crash.

## Telegram commands

- `/seo_help`
- `/seo_chat_id`
- `/generate`
- `/seo_status ARTICLE-ID`
- `/seo_regenerate ARTICLE-ID [editor feedback]`
- `/seo_approve ARTICLE-ID`
- `/seo_cancel ARTICLE-ID reason`

`ARTICLE-ID` can be omitted when the command is sent as a reply to a review card. Regeneration replaces the same review row only after OpenAI succeeds, keeps the old draft on failure, increments `revision_count`, and never reopens an approved or published article. Generation, regeneration, status, approval, and cancellation commands from private chats or any group other than the configured review group are rejected. `/seo_help` is public help, and `/seo_chat_id` intentionally works before a group is bound.

`/generate` accepts no arguments. It reserves the physically topmost row on `keywords` whose status is `ready`; row order is the manual priority, so the numeric `priority` value is ignored for this dequeue. Keyword, locale, and content settings come from that existing row. After OpenAI returns an article, the keyword becomes `used` even if article QA fails; a technical generation failure instead moves it to `paused` without an automatic paid retry. The generated article still requires Telegram review and never bypasses QA or approval. Manual generation requires both `ALLOW_TELEGRAM_GENERATION=true` in the server environment and `telegram_generation_enabled=true` in the Sheet. Scheduled generation remains independently controlled by `generation_enabled`. The manual queue is bounded by `telegram_generation_queue_limit` (default: 3), and any arguments passed to `/generate` are rejected.

## Configuration

Copy `.env.example` to an ignored `.env.local` for local development. Never put credentials in the spreadsheet.

Required secrets:

- `TELEGRAM_BOT_TOKEN`
- `GHOST_ADMIN_API_KEY`
- either `GOOGLE_APPLICATION_CREDENTIALS` or `GOOGLE_SERVICE_ACCOUNT_JSON`
- `OPENAI_API_KEY` to enable generation

The Google service account must be explicitly shared onto the spreadsheet as an editor. The Google authorization used interactively in Codex cannot be reused by the deployed process.

The configured Ghost URL is the instance root, not the raw API path:

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

Health endpoints:

- `GET /healthz` — process is alive.
- `GET /readyz` — Sheets schema, Ghost auth, and Telegram auth all passed startup checks.

## Deployment

Run exactly one replica initially. Telegram long polling and the current in-process locks assume a single writer. Mount the Google service-account JSON as a Docker secret, inject the remaining secrets through the server's secret store, and keep `DRY_RUN=true` for the first staging pass.

The current `/internal/` Ghost is not truly private: public Ghost pages, sitemap, and RSS are reachable even though `robots.txt` disallows crawling. Keep `technical_seo_ready=false` until canonical, hreflang, RU routing, and exposure decisions are resolved.

See [docs/ROADMAP.md](docs/ROADMAP.md) for the implementation and launch backlog, and
[docs/OPERATOR_GUIDE_RU.md](docs/OPERATOR_GUIDE_RU.md) for the owner workflow and client handoff.
