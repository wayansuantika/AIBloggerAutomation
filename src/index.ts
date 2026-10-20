import { authUrl, exchangeCode, syncPosts } from "./blogger";
import type { Env, RunParams } from "./types";
import { errMsg, json } from "./util";

export { PublishWorkflow } from "./workflow";

export default {
  // Daily cron: start one workflow instance per post.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const n = Math.max(1, Math.min(10, parseInt(env.POSTS_PER_RUN || "1", 10) || 1));
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
        const res = await env.DB.batch(
          items.map((t) =>
            env.DB.prepare("INSERT OR IGNORE INTO topics (hotel_name, area, priority) VALUES (?, ?, ?)")
              .bind(t.hotel_name, t.area ?? null, t.priority ?? 0),
          ),
        );
        const added = res.reduce((s, r) => s + (r.meta.changes ?? 0), 0);
        return json({ received: items.length, added, ignored_duplicates: items.length - added });
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
  const given = header ?? url.searchParams.get("token") ?? "";
  if (!env.ADMIN_TOKEN || !given) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(env.ADMIN_TOKEN);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
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
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [name, area, prio] = l.split("|").map((s) => s.trim());
      return { hotel_name: name, area: area || undefined, priority: prio ? Number(prio) : 0 };
    });
}
