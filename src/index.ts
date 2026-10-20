import { authUrl, exchangeCode, publishPost, syncPosts, upsertPostStmt } from "./blogger";
import { notify } from "./notify";
import type { Env, RunParams } from "./types";
import { errMsg, json } from "./util";

export { PublishWorkflow } from "./workflow";

export default {
  // Daily cron: start one workflow instance per post.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const n = postsPerRun(env);
    const params: RunParams = { trigger: "cron" };
    ctx.waitUntil(Promise.all(Array.from({ length: n }, () => env.PUBLISH_WORKFLOW.create({ params }))));
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // --- OAuth callback (protected by one-time state, not the admin token) ---
      if (path === "/oauth/callback") {
        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        const saved = await env.DB.prepare("SELECT value FROM settings WHERE key='oauth_state'").first<{ value: string }>();
        if (!state || !code || !saved || saved.value !== state) return new Response("Invalid OAuth state", { status: 400 });
        await env.DB.prepare("DELETE FROM settings WHERE key='oauth_state'").run();
        await exchangeCode(env, code, url.origin);
        return new Response("Blogger connected. Refresh token saved. You can close this tab.", { status: 200 });
      }

      // --- Telegram bot webhook (protected by the secret token Telegram sends back, set via setWebhook) ---
      if (path === "/telegram" && req.method === "POST") {
        if (!tokenMatches(req.headers.get("x-telegram-bot-api-secret-token") ?? "", env.ADMIN_TOKEN)) {
          return new Response("Unauthorized", { status: 401 });
        }
        const msg = ((await req.json()) as { message?: { chat: { id: number }; text?: string } }).message;
        // Only the configured chat may add hotels; anyone else who finds the bot is ignored.
        if (!msg?.text || String(msg.chat.id) !== env.TELEGRAM_CHAT_ID) return new Response("ok");
        if (msg.text.startsWith("/queue")) {
          await notify(env, await weekQueue(env));
          return new Response("ok");
        }
        // Require /add so ordinary chat messages never become topics.
        const remove = msg.text.match(/^\/remove(@\w+)?\s+#?(\d+)/);
        if (remove) {
          // Only pending topics: never delete one a run is processing or has already posted.
          const t = await env.DB.prepare("DELETE FROM topics WHERE id = ? AND status = 'pending' RETURNING hotel_name")
            .bind(Number(remove[2]))
            .first<{ hotel_name: string }>();
          await notify(env, t ? `🗑️ Removed #${remove[2]} ${t.hotel_name}` : `No pending hotel #${remove[2]}. Send /queue to see the numbers.`);
          return new Response("ok");
        }
        const pub = msg.text.match(/^\/publish(@\w+)?\s+#?(\d+)/);
        if (pub) {
          const id = Number(pub[2]);
          // Errors are reported to the chat and swallowed; a 500 would make Telegram resend the command.
          try {
            const t = await env.DB.prepare("SELECT post_id FROM topics WHERE id = ? AND post_id IS NOT NULL")
              .bind(id)
              .first<{ post_id: string }>();
            if (!t) {
              await notify(env, `No draft for #${id}.`);
              return new Response("ok");
            }
            const p = await publishPost(env, t.post_id);
            await env.DB.batch([
              upsertPostStmt(env, p.id, p.title, p.url, p.labels, p.status, p.published),
              env.DB.prepare("UPDATE topics SET post_url = ? WHERE id = ?").bind(p.url ?? null, id),
            ]);
            await notify(env, `🚀 Published #${id}: ${p.title}\n${p.url ?? ""}`);
          } catch (e) {
            await notify(env, `❌ Publish #${id} failed: ${errMsg(e)}`);
          }
          return new Response("ok");
        }
        const add = msg.text.match(/^\/add(@\w+)?(\s|$)/);
        const items = add ? parseLines(msg.text.slice(add[0].length)) : [];
        if (!items.length) {
          await notify(env, "/add followed by hotels, one per line:\n/add Hotel Name | Area | priority\nAnother Hotel | Area\n(area and priority are optional)\n\n/queue - hotels scheduled for the next 7 days\n/remove 12 - remove hotel #12 from the queue\n/publish 12 - make the draft for #12 live");
          return new Response("ok");
        }
        const r = await addTopics(env, items);
        await notify(env, `➕ Added ${r.added} of ${r.received} hotel(s) to the queue.${r.ignored_duplicates ? ` ${r.ignored_duplicates} already queued.` : ""}`);
        return new Response("ok");
      }

      // Everything below requires the admin token.
      if (!(await authorized(req, url, env))) return new Response("Unauthorized", { status: 401 });

      if (path === "/oauth/start" && req.method === "GET") {
        const state = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO settings (key, value) VALUES ('oauth_state', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ).bind(state).run();
        return Response.redirect(authUrl(env, url.origin, state), 302);
      }

      if (path === "/sync-posts" && req.method === "POST") {
        const count = await syncPosts(env);
        return json({ synced: count });
      }

      if (path === "/topics" && req.method === "POST") {
        const items = await parseTopics(req);
        if (!items.length) return json({ error: "No topics found in body" }, 400);
        return json(await addTopics(env, items));
      }

      if (path === "/run" && req.method === "POST") {
        const topicId = url.searchParams.get("topic");
        const instance = await env.PUBLISH_WORKFLOW.create({
          params: { trigger: "manual", ...(topicId ? { topicId: Number(topicId) } : {}) },
        });
        return json({ started: instance.id });
      }

      if (path === "/run-status" && req.method === "GET") {
        const id = url.searchParams.get("id");
        if (!id) return json({ error: "id required" }, 400);
        const instance = await env.PUBLISH_WORKFLOW.get(id);
        return json(await instance.status());
      }

      if (path === "/requeue" && req.method === "POST") {
        // Move failed topics (and ones stuck in 'processing' > 1h) back to pending.
        const r = await env.DB.prepare(
          `UPDATE topics SET status='pending', updated_at=datetime('now')
           WHERE status='failed' OR (status='processing' AND updated_at < datetime('now','-1 hour'))`,
        ).run();
        return json({ requeued: r.meta.changes });
      }

      if (path === "/status" && req.method === "GET") {
        const counts = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM topics GROUP BY status").all();
        const runs = await env.DB.prepare(
          `SELECT r.run_id, t.hotel_name, r.status, r.post_url, r.input_tokens, r.output_tokens, r.web_searches,
                  r.error, r.started_at, r.finished_at
           FROM runs r LEFT JOIN topics t ON t.id = r.topic_id ORDER BY r.started_at DESC LIMIT 15`,
        ).all();
        return json({ mode: env.PUBLISH_MODE, topics: counts.results, recent_runs: runs.results });
      }

      return new Response(
        "Alamat Hotel Bali autoblog. Admin endpoints: /status, /topics, /run, /run-status, /requeue, /sync-posts, /oauth/start",
        { status: 404 },
      );
    } catch (e) {
      return json({ error: errMsg(e) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function authorized(req: Request, url: URL, env: Env): Promise<boolean> {
  const header = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return tokenMatches(header ?? url.searchParams.get("token") ?? "", env.ADMIN_TOKEN);
}

function tokenMatches(given: string, expected: string | undefined): boolean {
  if (!expected || !given) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

function postsPerRun(env: Env): number {
  return Math.max(1, Math.min(10, parseInt(env.POSTS_PER_RUN || "1", 10) || 1));
}

/** Pending hotels for the next 7 daily runs, in the order the workflow claims them. */
async function weekQueue(env: Env): Promise<string> {
  const perDay = postsPerRun(env);
  const { results } = await env.DB.prepare(
    "SELECT id, hotel_name, area FROM topics WHERE status='pending' ORDER BY priority DESC, id LIMIT ?",
  ).bind(perDay * 7).all<{ id: number; hotel_name: string; area: string | null }>();
  if (!results.length) return "📭 Queue is empty. Send hotel names to add them.";

  // shortcut: assumes the "13 0 * * *" cron in wrangler.jsonc, update this if the schedule changes.
  const next = new Date();
  if (next.getUTCHours() > 0 || next.getUTCMinutes() >= 13) next.setUTCDate(next.getUTCDate() + 1);
  next.setUTCHours(0, 13, 0, 0);
  const lines = results.map((t, i) => {
    const day = new Date(next.getTime() + Math.floor(i / perDay) * 86_400_000).toLocaleDateString("en-GB", {
      weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Makassar",
    });
    return `#${t.id} ${day}: ${t.hotel_name}${t.area ? ` (${t.area})` : ""}`;
  });
  return `📅 Next 7 days (${perDay}/day, 08:13 WITA):\n${lines.join("\n")}`;
}

async function addTopics(env: Env, items: TopicInput[]) {
  const res = await env.DB.batch(
    items.map((t) =>
      env.DB.prepare("INSERT OR IGNORE INTO topics (hotel_name, area, priority) VALUES (?, ?, ?)")
        .bind(t.hotel_name, t.area ?? null, t.priority ?? 0),
    ),
  );
  const added = res.reduce((s, r) => s + (r.meta.changes ?? 0), 0);
  return { received: items.length, added, ignored_duplicates: items.length - added };
}

interface TopicInput {
  hotel_name: string;
  area?: string;
  priority?: number;
}

/**
 * Accepts either JSON ([{hotel_name, area, priority}] or {"hotels": [...]})
 * or plain text, one hotel per line: "Hotel Name | Area | priority"
 */
async function parseTopics(req: Request): Promise<TopicInput[]> {
  const body = await req.text();
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("json") || body.trim().startsWith("[") || body.trim().startsWith("{")) {
    const data = JSON.parse(body) as TopicInput[] | { hotels: TopicInput[] };
    const list = Array.isArray(data) ? data : data.hotels;
    return (list ?? []).filter((t) => t?.hotel_name?.trim()).map((t) => ({ ...t, hotel_name: t.hotel_name.trim() }));
  }
  return parseLines(body);
}

/** Plain text, one hotel per line: "Hotel Name | Area | priority". Lines starting with # are ignored. */
function parseLines(body: string): TopicInput[] {
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [name, area, prio] = l.split("|").map((s) => s.trim());
      return { hotel_name: name, area: area || undefined, priority: prio ? Number(prio) : 0 };
    });
}
