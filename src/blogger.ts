import type { Env } from "./types";
import { normalizeName } from "./util";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/blogger/v3";
export const BLOGGER_SCOPE = "https://www.googleapis.com/auth/blogger";

export function redirectUri(origin: string): string {
  return `${origin}/oauth/callback`;
}

export function authUrl(env: Env, origin: string, state: string): string {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: BLOGGER_SCOPE,
    access_type: "offline",
    prompt: "consent", // forces a refresh token to be issued
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function exchangeCode(env: Env, code: string, origin: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(origin),
      grant_type: "authorization_code",
    }),
  });
  const data = (await res.json()) as { refresh_token?: string; error?: string; error_description?: string };
  if (!res.ok || !data.refresh_token) {
    throw new Error(`OAuth exchange failed: ${data.error ?? res.status} ${data.error_description ?? ""}`);
  }
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('blogger_refresh_token', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(data.refresh_token)
    .run();
  return data.refresh_token;
}

async function accessToken(env: Env): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'blogger_refresh_token'").first<{ value: string }>();
  if (!row) throw new Error("No Blogger refresh token. Visit /oauth/start?token=ADMIN_TOKEN first.");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: row.value,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    // invalid_grant usually means the token expired (OAuth app left in "Testing") or was revoked.
    throw new Error(`Token refresh failed: ${data.error ?? res.status} ${data.error_description ?? ""}`);
  }
  return data.access_token;
}

export interface NewPost {
  title: string;
  content: string;
  labels: string[];
  location?: { name: string; lat: number; lng: number };
}

export interface CreatedPost {
  id: string;
  url?: string;
  status?: string;
}

export async function insertPost(env: Env, post: NewPost, isDraft: boolean): Promise<CreatedPost> {
  const token = await accessToken(env);
  const res = await fetch(`${API}/blogs/${env.BLOG_ID}/posts?isDraft=${isDraft}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ kind: "blogger#post", ...post }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Blogger insert failed (${res.status}): ${text.slice(0, 500)}`);
  const data = JSON.parse(text) as CreatedPost;
  return { id: data.id, url: data.url, status: data.status };
}

/** Make an existing draft live. Returns the post with its public URL. */
export async function publishPost(env: Env, postId: string): Promise<ListedPost> {
  const token = await accessToken(env);
  const res = await fetch(`${API}/blogs/${env.BLOG_ID}/posts/${postId}/publish`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Blogger publish failed (${res.status}): ${text.slice(0, 500)}`);
  return JSON.parse(text) as ListedPost;
}

interface ListedPost {
  id: string;
  title: string;
  url?: string;
  labels?: string[];
  status?: string;
  published?: string;
}

/** Pull every post (live + drafts + scheduled) into D1 for dedupe and internal linking. */
export async function syncPosts(env: Env): Promise<number> {
  const token = await accessToken(env);
  let pageToken: string | undefined;
  let count = 0;
  do {
    const p = new URLSearchParams({
      maxResults: "100",
      fetchBodies: "false",
      view: "ADMIN",
      fields: "nextPageToken,items(id,title,url,labels,status,published)",
    });
    for (const s of ["LIVE", "DRAFT", "SCHEDULED"]) p.append("status", s);
    if (pageToken) p.set("pageToken", pageToken);

    const res = await fetch(`${API}/blogs/${env.BLOG_ID}/posts?${p}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Blogger list failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { items?: ListedPost[]; nextPageToken?: string };

    const items = data.items ?? [];
    if (items.length) {
      await env.DB.batch(items.map((it) => upsertPostStmt(env, it.id, it.title, it.url, it.labels, it.status, it.published)));
      count += items.length;
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return count;
}

export function upsertPostStmt(
  env: Env,
  id: string,
  title: string,
  url?: string,
  labels?: string[],
  status?: string,
  published?: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO posts (post_id, title, norm_title, url, labels, status, published)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(post_id) DO UPDATE SET title=excluded.title, norm_title=excluded.norm_title,
       url=excluded.url, labels=excluded.labels, status=excluded.status, published=excluded.published`,
  ).bind(id, title, normalizeName(title), url ?? null, (labels ?? []).join(","), status ?? null, published ?? null);
}
