import type { AgentArticle } from "./types";
import { escapeHtml } from "./util";

/** Wraps the agent's sanitized body with the address block, map and Hotel JSON-LD (layout follows sample.html). */
export function buildPostHtml(a: AgentArticle, safeBody: string): string {
  const e = escapeHtml;
  const mapEmbed = `https://maps.google.com/maps?q=${a.lat},${a.lng}&z=15&output=embed`;

  const contact: string[] = [`<strong>Address:</strong> ${e(a.address)}`];
  if (a.phone) contact.push(`<strong>Contact Number:</strong> ${e(a.phone)}`);
  if (a.official_website) {
    contact.push(`<strong>Website:</strong> <a href="${e(a.official_website)}" target="_blank" rel="nofollow noopener">Official website</a>`);
  }

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Hotel",
    name: a.hotel_name,
    description: a.summary,
    address: {
      "@type": "PostalAddress",
      streetAddress: a.address,
      addressLocality: a.area,
      addressRegion: "Bali",
      addressCountry: "ID",
    },
    geo: { "@type": "GeoCoordinates", latitude: a.lat, longitude: a.lng },
    ...(a.phone ? { telephone: a.phone } : {}),
    ...(a.official_website ? { url: a.official_website } : {}),
    ...(a.star_rating ? { starRating: { "@type": "Rating", ratingValue: a.star_rating } } : {}),
  };
  // Prevent "</script>" inside strings from closing the tag.
  const ld = JSON.stringify(jsonLd).replace(/</g, "\\u003c");

  // Jump break after the intro paragraph so the homepage shows only the hook.
  return `${safeBody.replace("</p>", "</p>\n<!--more-->")}

<p>${contact.join("<br/>\n")}</p>

<h2>Location Map</h2>
<div class="map-container" style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;max-width:100%;">
<iframe src="${mapEmbed}" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;" allowfullscreen="" loading="lazy" referrerpolicy="no-referrer-when-downgrade" title="Map of ${e(a.hotel_name)}"></iframe>
</div>

<script type="application/ld+json">${ld}</script>`;
}
