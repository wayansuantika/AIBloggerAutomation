import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { runAgent } from "./agent";
import { insertPost, upsertPostStmt, type NewPost } from "./blogger";
import { notify } from "./notify";
import { buildPostHtml } from "./template";
import type { AgentResult, Env, RelatedPost, RunParams, Topic } from "./types";
import { errMsg, labels, normalizeName } from "./util";
import { checkArticle, sanitizeHtml } from "./validate";

const SKIP = "SKIP:"; // prefix for expected, non-error outcomes (duplicate, not found, closed)

export class PublishWorkflow extends WorkflowEntrypoint<Env, RunParams> {
  async run(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
    const env = this.env;
    const runId = event.instanceId;
    const isDraft = env.PUBLISH_MODE !== "live";

    // 1. Atomically claim the next topic so parallel runs never pick the same hotel.
    const topic = await step.do("claim topic", async () => {
      const forced = event.payload.topicId;
      const sql = forced
        ? `UPDATE topics SET status='processing', attempts=attempts+1, updated_at=datetime('now')
           WHERE id = ? AND status IN ('pending','failed') RETURNING id, hotel_name, area`
        : `UPDATE topics SET status='processing', attempts=attempts+1, updated_at=datetime('now')
           WHERE id = (SELECT id FROM topics WHERE status='pending' ORDER BY priority DESC, id LIMIT 1)
           RETURNING id, hotel_name, area`;
      const stmt = forced ? env.DB.prepare(sql).bind(forced) : env.DB.prepare(sql);
      const t = await stmt.first<Topic>();
      await env.DB.prepare("INSERT INTO runs (run_id, topic_id, status) VALUES (?, ?, ?)")
        .bind(runId, t?.id ?? null, t ? "running" : "empty")
        .run();
      return t ?? null;
    });

    if (!topic) {
      await step.do("notify empty queue", async () => {
        await notify(env, "⚠️ Alamat Hotel Bali: topic queue is empty. Add hotels via POST /topics.");
      });
      return { status: "empty" };
    }

    try {
      // 2. Cheap dedupe before spending on the agent.
      await step.do("dedupe check", async () => {
        const dup = await findDuplicate(env, topic.hotel_name);
        if (dup) throw new NonRetryableError(`${SKIP} already on blog as "${dup}"`);
      });

      // 3. Related posts for one optional internal link.
      const related = await step.do("load related posts", async () => relatedPosts(env, topic.area));

      // 4. Agent: research + write. Retried independently; a later failure won't re-run (and re-pay) this.
      const agent: AgentResult = await step.do(
        "agent research and write",
        { retries: { limit: 2, delay: "1 minute", backoff: "exponential" }, timeout: "15 minutes" },
        async () => runAgent(env, topic, related),
      );

      // 5. Deterministic validation + HTML assembly.
      const post: NewPost = await step.do("validate and build", async () => {
        const a = agent.article;
        if (a.status === "not_found" || a.status === "closed") {
          throw new NonRetryableError(`${SKIP} agent reported hotel ${a.status}. ${a.notes ?? ""}`);
        }
        const problems = checkArticle(a, labels(env));
        if (problems.length) throw new NonRetryableError(`Validation failed: ${problems.join("; ")}`);

        const dup = await findDuplicate(env, a.hotel_name);
        if (dup) throw new NonRetryableError(`${SKIP} already on blog as "${dup}"`);

        const safeBody = await sanitizeHtml(a.body_html, env.BLOG_URL);
        return {
          title: a.title.trim(),
          content: buildPostHtml(a, safeBody),
          labels: [a.area],
          location: { name: a.address, lat: a.lat, lng: a.lng },
        };
      });

      // 6. Publish. Idempotent: if a previous attempt already created the post, reuse it.
      const created = await step.do(
        "publish to Blogger",
        { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" } },
        async () => {
          const prior = await env.DB.prepare("SELECT post_id, post_url FROM topics WHERE id = ? AND post_id IS NOT NULL")
            .bind(topic.id)
            .first<{ post_id: string; post_url: string | null }>();
          if (prior) return { id: prior.post_id, url: prior.post_url ?? undefined };

          const c = await insertPost(env, post, isDraft);
          await env.DB.prepare("UPDATE topics SET post_id = ?, post_url = ? WHERE id = ?")
            .bind(c.id, c.url ?? null, topic.id)
            .run();
          return { id: c.id, url: c.url };
        },
      );

      // 7. Record success.
      await step.do("record success", async () => {
        const status = isDraft ? "drafted" : "published";
        await env.DB.batch([
          env.DB.prepare("UPDATE topics SET status='done', last_error=NULL, updated_at=datetime('now') WHERE id = ?").bind(topic.id),
          upsertPostStmt(env, created.id, post.title, created.url, post.labels, isDraft ? "DRAFT" : "LIVE", new Date().toISOString()),
          env.DB.prepare(
            `UPDATE runs SET status=?, post_id=?, post_url=?, input_tokens=?, output_tokens=?, web_searches=?,
             sources=?, agent_notes=?, finished_at=datetime('now') WHERE run_id=?`,
          ).bind(
            status, created.id, created.url ?? null,
            agent.usage.input_tokens, agent.usage.output_tokens, agent.usage.web_searches,
            JSON.stringify(agent.article.sources), agent.article.notes ?? null, runId,
          ),
        ]);
        const where = isDraft
          ? `Draft #${topic.id} ready: https://www.blogger.com/blog/post/edit/${env.BLOG_ID}/${created.id}\nApprove with /publish ${topic.id}`
          : (created.url ?? "Published");
        const notes = agent.article.notes ? `\nAgent notes: ${agent.article.notes.slice(0, 300)}` : "";
        await notify(env, `✅ ${post.title}\n${where}${notes}`);
      });

      return { status: isDraft ? "drafted" : "published", postId: created.id };
    } catch (e) {
      const msg = errMsg(e);
      const skipped = msg.includes(SKIP);
      await step.do("record failure", async () => {
        await env.DB.batch([
          env.DB.prepare("UPDATE topics SET status=?, last_error=?, updated_at=datetime('now') WHERE id=?")
            .bind(skipped ? "skipped" : "failed", msg.slice(0, 1000), topic.id),
          env.DB.prepare("UPDATE runs SET status=?, error=?, finished_at=datetime('now') WHERE run_id=?")
            .bind(skipped ? "skipped" : "failed", msg.slice(0, 1000), runId),
        ]);
        await notify(env, `${skipped ? "⏭️ Skipped" : "❌ Failed"}: ${topic.hotel_name}\n${msg.slice(0, 500)}`);
      });
      return { status: skipped ? "skipped" : "failed", error: msg };
    }
  }
}

async function findDuplicate(env: Env, hotelName: string): Promise<string | null> {
  const norm = normalizeName(hotelName);
  if (norm.length < 4) return null;
  const row = await env.DB.prepare("SELECT title FROM posts WHERE norm_title LIKE '%' || ? || '%' LIMIT 1")
    .bind(norm)
    .first<{ title: string }>();
  return row?.title ?? null;
}

async function relatedPosts(env: Env, area: string | null): Promise<RelatedPost[]> {
  const q = area
    ? env.DB.prepare(
        "SELECT title, url FROM posts WHERE status='LIVE' AND url IS NOT NULL AND labels LIKE '%' || ? || '%' ORDER BY published DESC LIMIT 10",
      ).bind(area)
    : env.DB.prepare("SELECT title, url FROM posts WHERE status='LIVE' AND url IS NOT NULL ORDER BY published DESC LIMIT 10");
  const { results } = await q.all<RelatedPost>();
  return results;
}
