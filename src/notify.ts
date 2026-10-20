import type { Env } from "./types";

/** Best-effort notification. Never throws. */
export async function notify(env: Env, text: string): Promise<void> {
  const jobs: Promise<unknown>[] = [];
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    jobs.push(
      fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
      }),
    );
  }
  if (env.NOTIFY_WEBHOOK_URL) {
    // Discord uses "content", Slack uses "text"; send both.
    jobs.push(
      fetch(env.NOTIFY_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: text, text }),
      }),
    );
  }
  await Promise.allSettled(jobs);
}
