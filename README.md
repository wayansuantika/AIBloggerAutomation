# Alamat Hotel Bali — Autoblog

A daily Cloudflare Workflow that picks a hotel from a queue, has a Claude agent research it on the web
(official site + booking listings), writes a fact-checked guide, validates it, and posts it to Blogger.

```
Cron (08:13 WITA) → Worker → PublishWorkflow
  1. claim topic (D1, atomic)
  2. dedupe vs existing posts
  3. load related posts (internal link)
  4. Claude agent: web_search + web_fetch → submit_post (JSON)   [retried on its own]
  5. validate + sanitize + build HTML (address block, map, Hotel JSON-LD)
  6. Blogger posts.insert (draft or live, with labels + location)   [idempotent]
  7. log to D1 + notify Telegram/Discord
```

## 1. Install

```bash
npm install
npx wrangler login
```

## 2. Create the database

```bash
npx wrangler d1 create autoblog
```
Copy the `database_id` it prints into `wrangler.jsonc`, then:

```bash
npm run db:init
```

## 3. Configure `wrangler.jsonc`

- `BLOG_ID`: open your blog in the Blogger dashboard; the number in the URL `blogger.com/blog/posts/<BLOG_ID>`.
- `PUBLISH_MODE`: keep `"draft"` until you trust the output.
- `ALLOWED_LABELS`: must match your Blogger labels exactly (check spelling of "Nusa Dua", "Ubud", etc.).
- `CLAUDE_MODEL`: `claude-sonnet-5-5` is a good cost/quality balance. Use an Opus model for higher quality.

## 4. Google OAuth (Blogger access)

1. Google Cloud Console → create a project → **APIs & Services → Library** → enable **Blogger API v3**.
2. **OAuth consent screen**: External, add your Google account as a test user, scope `.../auth/blogger`.
3. **Important:** set **Publishing status → In production**. Apps left in "Testing" get refresh tokens that
   expire after 7 days, and the pipeline will stop with `invalid_grant`. (Unverified is fine for your own account;
   you'll click through a warning once.)
4. **Credentials → Create OAuth client ID → Web application.** Authorized redirect URI:
   `https://alamat-bali-autoblog.<your-subdomain>.workers.dev/oauth/callback`

## 5. Secrets

```bash
npx wrangler secret put ANTHROPIC_API_KEY      # from console.anthropic.com (API billing, not your Claude.ai plan)
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put ADMIN_TOKEN            # any long random string
# optional notifications
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put NOTIFY_WEBHOOK_URL     # Discord webhook URL works
```

## 6. Deploy and connect Blogger

```bash
npm run deploy
```
Open in your browser (signed in to the Google account that owns the blog):
```
https://alamat-bali-autoblog.<sub>.workers.dev/oauth/start?token=YOUR_ADMIN_TOKEN
```
You should see "Blogger connected".

## 7. Import existing posts (dedupe + internal links)

```bash
W=https://alamat-bali-autoblog.<sub>.workers.dev
T="Authorization: Bearer YOUR_ADMIN_TOKEN"
curl -X POST -H "$T" $W/sync-posts
```

## 8. Add hotels to the queue

Plain text, one per line: `Hotel Name | Area | priority` (area and priority optional, higher priority first):

```bash
curl -X POST -H "$T" --data-binary @hotels.txt $W/topics
```
```
# hotels.txt
The Mulia Bali | Nusa Dua | 5
Alila Villas Uluwatu | Uluwatu
COMO Uma Canggu | Canggu
```
JSON also works: `[{"hotel_name":"...","area":"...","priority":0}]`. Duplicates are ignored.

## 9. Test run

```bash
curl -X POST -H "$T" $W/run                 # next topic in queue
curl -X POST -H "$T" "$W/run?topic=12"      # a specific topic
curl -H "$T" "$W/run-status?id=<instance id>"
curl -H "$T" $W/status                      # queue counts + last 15 runs (tokens, errors, URLs)
curl -X POST -H "$T" $W/requeue             # failed + stuck topics back to pending
```
Check the draft in Blogger. When a few in a row look right, set `PUBLISH_MODE` to `"live"` and redeploy.

## Tuning

- **Writing style / structure**: edit `STYLE_GUIDE` in `src/agent.ts`.
- **Quality gates**: `checkArticle` in `src/validate.ts` (word count, banned phrases, Bali bounds, sources).
- **Post layout**: `src/template.ts` (address block, map embed, JSON-LD; layout follows `sample.html`).
- **Posts per day**: `POSTS_PER_RUN`. Keep it modest; quality beats volume for a directory blog.
- **Cost control**: the agent is capped at 6 searches, 6 fetches and 8 turns per hotel. `/status` shows tokens per run.

## Things to verify on first run

- The Blogger theme shows the post **Location** (it does on existing posts) and keeps the JSON-LD `<script>`.
  If Blogger strips the script, remove it from `src/template.ts`.
- Claude API tool versions in `src/agent.ts` (`web_search_20250305`, `web_fetch_20250910`) are the stable ones.
  Newer versions with dynamic filtering exist; see the Claude API docs if you want to switch.

## Statuses

`topics.status`: `pending → processing → done | skipped | failed`
- `skipped`: duplicate already on the blog, or the agent couldn't verify the hotel / it's closed.
- `failed`: validation or API error; see `last_error`. Fix and `/requeue`.
