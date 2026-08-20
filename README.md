# Playroom Nearby SEO Bot

Long-running TypeScript service that treats the [Playroom SEO spreadsheet](https://docs.google.com/spreadsheets/d/10QigScXswOt9QUns059V5PWqc29aOul74UwNoUGSeAM/edit) as its control plane:

```text
keywords → OpenAI generation/research → articles → Telegram review
/generate ────────────────┘         → /approve → Ghost publish → verify
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
- Deterministic QA for locale, title, slug, metadata, sources, allow-listed internal links, manual blockers, and score.
- Ghost 5.x JWT authentication, localized slugs (`-en`, `-rs`), HTML sanitization, draft-first upsert, optimistic `updated_at` lock, and public-page verification.
- OpenAI Responses API generation with web research and strict structured output.
- Append-only audit events, single-process per-article locking, health endpoints, Docker build, and unit tests.
- Recovery for stale `publishing` claims, including reconciliation when Ghost was updated before a process crash.

## Telegram commands

- `/generate`
- `/regenerate editor feedback`
- `/approve`
- `/help`

Only one article can be in manual generation or review at a time. While a previous article is being generated or still awaits review, another `/generate` is rejected with a pointer to the existing work. `/regenerate editor feedback` immediately rewrites that sole active review article, and bare `/approve` approves it; sending either command as a direct reply selects the visible card explicitly. Editor feedback is mandatory for regeneration, while `/approve` accepts no arguments. There is no ARTICLE-ID fallback or inline action keyboard. Regeneration replaces the same review row only after OpenAI succeeds, keeps the old draft on failure, increments `revision_count`, and never reopens an approved or published article. Workflow commands from private chats or groups other than the configured review group are rejected. `/help` explains the three available actions.

`/generate` accepts no arguments. It reserves the physically topmost row on `keywords` whose status is `ready`; row order is the manual priority, so the numeric `priority` value is ignored for this dequeue. Keyword, locale, and content settings come from that existing row. A malformed top row is never skipped silently: Telegram names the row and invalid fields and links directly to the relevant Sheet range. After OpenAI returns an article, the keyword becomes `used` even if article QA fails; a technical generation failure instead moves it to `paused` without an automatic paid retry. The generated article still requires Telegram review and never bypasses QA or approval. Manual generation requires both `ALLOW_TELEGRAM_GENERATION=true` in the server environment and `telegram_generation_enabled=true` in the Sheet. Scheduled generation remains independently controlled by `generation_enabled`, but the same single-active-article gate prevents it from producing a second review card. Any arguments passed to `/generate` are rejected.

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

On the configured Windows workstation, run `scripts/install-windows.ps1` once. It builds the service and the lightweight tray controller, creates a `Playroom SEO Bot` desktop shortcut, and does not add Windows-login autostart. Opening the shortcut starts the controller and bot. The tray menu exposes Start, Stop, Restart, and Exit; Stop and Exit request graceful service shutdown before any forced fallback.

Health endpoints:

- `GET /healthz` — process is alive.
- `GET /readyz` — Sheets schema, Ghost auth, and Telegram auth all passed startup checks.

## Deployment

Run exactly one replica initially. Telegram long polling and the current in-process locks assume a single writer. Mount the Google service-account JSON as a Docker secret, inject the remaining secrets through the server's secret store, and keep `DRY_RUN=true` for the first staging pass.

The current `/internal/` Ghost is not truly private: public Ghost pages, sitemap, and RSS are reachable even though `robots.txt` disallows crawling. Keep `technical_seo_ready=false` until canonical, hreflang, RU routing, and exposure decisions are resolved.

See [docs/ROADMAP.md](docs/ROADMAP.md) for the implementation and launch backlog, and
[docs/OPERATOR_GUIDE_RU.md](docs/OPERATOR_GUIDE_RU.md) for the owner workflow and client handoff.
