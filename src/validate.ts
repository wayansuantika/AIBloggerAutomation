import type { AgentArticle } from "./types";

// Rough bounding box for Bali incl. Nusa Penida/Lembongan and the west tip.
const BALI = { latMin: -8.95, latMax: -8.05, lngMin: 114.4, lngMax: 115.75 };

const ALLOWED_TAGS = new Set([
  "h2", "h3", "h4", "p", "ul", "ol", "li", "strong", "em", "b", "i", "a", "br",
  "table", "thead", "tbody", "tr", "th", "td", "blockquote",
]);
const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "form", "noscript", "svg", "img", "video", "audio"]);

const BANNED = [/nestled/i, /hidden gem/i, /unparalleled/i, /as an ai/i, /i stayed/i, /we stayed/i, /\bRp\s?\d/i, /\bIDR\s?\d/i, /\$\s?\d/];

export class ValidationError extends Error {}

/** Returns a list of problems. Empty list = article is publishable. */
export function checkArticle(a: AgentArticle, allowedLabels: string[]): string[] {
  const problems: string[] = [];
  if (a.status !== "ok") problems.push(`agent status: ${a.status}`);
  if (!a.hotel_name?.trim()) problems.push("missing hotel_name");
  if (!a.title?.trim() || a.title.length > 90) problems.push("title missing or too long");
  if (!allowedLabels.includes(a.area)) problems.push(`area "${a.area}" not in allowed labels`);
  if (!/bali/i.test(a.address ?? "")) problems.push("address does not mention Bali");
  if (
    typeof a.lat !== "number" || typeof a.lng !== "number" ||
    a.lat < BALI.latMin || a.lat > BALI.latMax || a.lng < BALI.lngMin || a.lng > BALI.lngMax
  ) problems.push(`coordinates outside Bali: ${a.lat},${a.lng}`);
  const sources = (a.sources ?? []).filter((s) => /^https?:\/\//.test(s));
  if (sources.length < 2) problems.push("fewer than 2 source URLs");
  if (!a.summary || a.summary.length < 80 || a.summary.length > 200) problems.push("summary length out of range");

  const words = wordCount(a.body_html ?? "");
  if (words < 300) problems.push(`body too short (${words} words)`);
  if (words > 900) problems.push(`body too long (${words} words)`);

  const allText = [a.title, a.summary, a.body_html].join(" ");
  for (const re of BANNED) if (re.test(allText)) problems.push(`banned phrase: ${re}`);
  return problems;
}

export function wordCount(html: string): number {
  const text = html.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ");
  return text.split(/\s+/).filter(Boolean).length;
}

/** Allowlist sanitizer using the Workers HTMLRewriter. */
export async function sanitizeHtml(html: string, blogUrl: string): Promise<string> {
  const blogHost = new URL(blogUrl).host;
  const rewriter = new HTMLRewriter().on("*", {
    element(el) {
      const tag = el.tagName.toLowerCase();
      if (DROP_WITH_CONTENT.has(tag)) {
        el.remove();
        return;
      }
      if (tag === "h1") el.tagName = "h2";
      else if (!ALLOWED_TAGS.has(tag)) {
        el.removeAndKeepContent();
        return;
      }

      const names = [...el.attributes].map(([n]) => n);
      const href = el.getAttribute("href");
      for (const n of names) el.removeAttribute(n);

      if (tag === "a") {
        if (href && /^https?:\/\//i.test(href)) {
          el.setAttribute("href", href);
          let external = true;
          try { external = new URL(href).host !== blogHost; } catch { /* keep external */ }
          if (external) {
            el.setAttribute("target", "_blank");
            el.setAttribute("rel", "nofollow noopener");
          }
        } else {
          el.removeAndKeepContent();
        }
      }
    },
  });
  return rewriter.transform(new Response(html)).text();
}
