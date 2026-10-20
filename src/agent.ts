import type { AgentArticle, AgentResult, Env, RelatedPost, Topic } from "./types";
import { labels } from "./util";

const API_URL = "https://api.anthropic.com/v1/messages";
const MAX_TURNS = 8; // hard cap on agent loop iterations

/** House style for alamatbalihotel.blogspot.com. Edit freely; this is the agent's brief. */
const STYLE_GUIDE = `
You write hotel guides for "Alamat Hotel Bali" (alamatbalihotel.blogspot.com), a directory of hotel and villa
addresses, locations and facilities in Bali. Readers are travelers deciding where to stay.

LANGUAGE: English. Clear, friendly, factual. No hype words ("nestled", "paradise", "unparalleled", "hidden gem").
No first person ("I", "we stayed"). Never claim to have visited.

ACCURACY RULES (most important):
- Every fact must come from the sources you found. If something is not in a source, leave it out.
- Prefer the hotel's official website, then major booking sites (Booking.com, Agoda, Traveloka, Tripadvisor) and Google Maps listings.
- Never include prices, current promotions, or review scores. They go stale.
- If you cannot confirm the hotel exists in Bali, set status "not_found". If it is permanently closed, set status "closed".
- Write everything in your own words. Do not copy sentences from sources.

STRUCTURE for body_html (700-900 words, allowed tags: h2 h3 p ul ol li strong em a table thead tbody tr th td):
1. <h2> with a descriptive guide heading (e.g. "{Hotel} Guide: Rooms, Facilities & Location in {Area}")
2. Intro paragraph: what kind of property, where, who it suits.
3. <h3>Location & How to Get There</h3>: area, nearby landmarks/beaches, approximate travel time from
   Ngurah Rai International Airport only if a source supports it.
4. <h3>Rooms & Villas</h3>: room/villa types as a list with key features.
5. <h3>Facilities</h3>: pools, spa, gym, kids club, etc. as a list.
6. <h3>Dining</h3>: on-site restaurants/bars, if any.
7. <h3>Nearby Attractions</h3>: 3-6 nearby places.
8. Optionally one internal link to a related post from the list provided, written as a natural sentence.
Do NOT include the address block, map, FAQ, or JSON-LD in body_html; the system adds those.

TITLE: "{Official Hotel Name} {Area}" style, short, no colons or "Ultimate Guide" (the URL slug is made from the title).
If the official name already contains the area or "Bali", don't repeat it.

SUMMARY: 140-160 characters, plain text, for search snippets.

FAQ: 3-5 short questions travelers actually ask (address, airport distance, family-friendly, beach access...),
answered only with sourced facts.

Finish by calling submit_post exactly once.
`.trim();

function submitTool(allowed: string[]) {
  return {
    name: "submit_post",
    description: "Submit the finished, fact-checked hotel article. Call exactly once when research and writing are done.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: [
        "status", "hotel_name", "title", "area", "address", "lat", "lng", "star_rating",
        "phone", "summary", "body_html", "faq", "sources", "notes",
      ],
      properties: {
        status: { type: "string", enum: ["ok", "not_found", "closed"] },
        hotel_name: { type: "string", description: "Official hotel name as the hotel writes it" },
        title: { type: "string" },
        area: { type: "string", enum: allowed, description: "Blogger label; pick the closest area" },
        address: { type: "string", description: "Full street address including Kabupaten, Bali, postcode if known" },
        lat: { type: "number" },
        lng: { type: "number" },
        star_rating: { type: ["integer", "null"], minimum: 1, maximum: 5 },
        official_website: { type: ["string", "null"] },
        phone: { type: ["string", "null"], description: "International format, e.g. +62 361 ..." },
        summary: { type: "string" },
        body_html: { type: "string" },
        faq: {
          type: "array",
          minItems: 3,
          maxItems: 5,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["q", "a"],
            properties: { q: { type: "string" }, a: { type: "string" } },
          },
        },
        sources: { type: "array", items: { type: "string" }, description: "URLs you actually used" },
        notes: { type: "string", description: "Anything uncertain or conflicting between sources" },
      },
    },
  };
}

interface ContentBlock {
  type: string;
  name?: string;
  input?: unknown;
  [k: string]: unknown;
}

interface MessagesResponse {
  content: ContentBlock[];
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    server_tool_use?: { web_search_requests?: number };
  };
  error?: { type: string; message: string };
}

export async function runAgent(env: Env, topic: Topic, related: RelatedPost[]): Promise<AgentResult> {
  const allowed = labels(env);
  const relatedList = related.length
    ? related.map((r) => `- ${r.title}: ${r.url}`).join("\n")
    : "(none yet)";

  const userPrompt = `Research and write a guide for this hotel:

Hotel: ${topic.hotel_name}
Area hint: ${topic.area ?? "unknown"}

Steps:
1. Search for the hotel. Find its official website and at least one other reliable listing.
2. Fetch the most useful pages (official site rooms/facilities pages, a booking listing).
3. Confirm the exact address and map coordinates (lat/lng). Google Maps URLs often contain "@lat,lng".
4. Write the article following the style guide, then call submit_post.

Related posts on the blog you may link to (optional, max one):
${relatedList}`;

  const tools = [
    { type: "web_search_20250305", name: "web_search", max_uses: 6, user_location: { type: "approximate", country: "ID", region: "Bali", timezone: "Asia/Makassar" } },
    { type: "web_fetch_20250910", name: "web_fetch", max_uses: 6, max_content_tokens: 15000 },
    submitTool(allowed),
  ];

  const messages: { role: "user" | "assistant"; content: unknown }[] = [{ role: "user", content: userPrompt }];
  const usage = { input_tokens: 0, output_tokens: 0, web_searches: 0 };

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-fetch-2025-09-10",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: env.CLAUDE_MODEL,
        max_tokens: 16000,
        system: STYLE_GUIDE,
        tools,
        messages,
      }),
    });

    const data = (await res.json()) as MessagesResponse;
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${data.error?.message ?? JSON.stringify(data).slice(0, 300)}`);

    usage.input_tokens += data.usage.input_tokens;
    usage.output_tokens += data.usage.output_tokens;
    usage.web_searches += data.usage.server_tool_use?.web_search_requests ?? 0;

    const submit = data.content.find((b) => b.type === "tool_use" && b.name === "submit_post");
    if (submit) return { article: submit.input as AgentArticle, usage };

    messages.push({ role: "assistant", content: data.content });

    if (data.stop_reason === "pause_turn") {
      // Server tools (search/fetch) paused a long turn; send the conversation back to let it continue.
      continue;
    }
    if (data.stop_reason === "max_tokens") {
      throw new Error("Agent hit max_tokens before submitting");
    }
    // end_turn without submitting: nudge once more.
    messages.push({ role: "user", content: "Now call submit_post with the finished article. Do not reply with plain text." });
  }
  throw new Error(`Agent did not submit within ${MAX_TURNS} turns`);
}
