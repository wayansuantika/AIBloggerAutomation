export interface Env {
  DB: D1Database;
  PUBLISH_WORKFLOW: Workflow<RunParams>;

  BLOG_ID: string;
  BLOG_URL: string;
  PUBLISH_MODE: string; // "draft" | "live"
  POSTS_PER_RUN: string;
  CLAUDE_MODEL: string;
  ALLOWED_LABELS: string;

  ANTHROPIC_API_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  ADMIN_TOKEN: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  NOTIFY_WEBHOOK_URL?: string;
}

export interface RunParams {
  trigger: "cron" | "manual";
  topicId?: number; // force a specific topic (manual runs)
}

export interface Topic {
  id: number;
  hotel_name: string;
  area: string | null;
}

export interface Faq {
  q: string;
  a: string;
}

/** What the agent must return via the submit_post tool. */
export interface AgentArticle {
  status: "ok" | "not_found" | "closed";
  hotel_name: string;
  title: string;
  area: string;
  address: string;
  lat: number;
  lng: number;
  star_rating: number | null;
  official_website: string | null;
  phone: string | null;
  summary: string;
  body_html: string;
  faq: Faq[];
  sources: string[];
  notes: string;
}

export interface AgentResult {
  article: AgentArticle;
  usage: { input_tokens: number; output_tokens: number; web_searches: number };
}

export interface RelatedPost {
  title: string;
  url: string;
}
