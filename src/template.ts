import type { AgentArticle } from "./types";
import { escapeHtml } from "./util";

/** Wraps the agent's sanitized body with the address block, map, FAQ and Hotel JSON-LD. */
export function buildPostHtml(a: AgentArticle, safeBody: string): string {
  const e = escapeHtml;
  const mapsLink = `https://www.google.com/maps/search/?api=1&query=${a.lat},${a.lng}`;
  const mapEmbed = `https://maps.google.com/maps?q=${a.lat},${a.lng}&z=15&output=embed`;

  const infoRows: string[] = [
    `<tr><th>Hotel</th><td>${e(a.hotel_name)}</td></tr>`,
    `<tr><th>Address</th><td>${e(a.address)}</td></tr>`,
    `<tr><th>Area</th><td>${e(a.area)}, Bali</td></tr>`,
  ];
  if (a.star_rating) infoRows.push(`<tr><th>Rating</th><td>${a.star_rating}-star</td></tr>`);
  if (a.phone) infoRows.push(`<tr><th>Phone</th><td>${e(a.phone)}</td></tr>`);
  if (a.official_website) {
    infoRows.push(
      `<tr><th>Website</th><td><a href="${e(a.official_website)}" target="_blank" rel="nofollow noopener">Official website</a></td></tr>`,
    );
  }
  infoRows.push(`<tr><th>Map</th><td><a href="${mapsLink}" target="_blank" rel="noopener">Open in Google Maps</a></td></tr>`);

  const faqHtml = a.faq
    .map((f) => `<h3>${e(f.q)}</h3>\n<p>${e(f.a)}</p>`)
    .join("\n");

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Hotel",
        name: a.hotel_name,
        description: a.summary,
        address: {
          "@type": "PostalAddress",
          streetAddress: a.address,
          addressRegion: "Bali",
          addressCountry: "ID",
        },
        geo: { "@type": "GeoCoordinates", latitude: a.lat, longitude: a.lng },
        ...(a.phone ? { telephone: a.phone } : {}),
        ...(a.official_website ? { url: a.official_website } : {}),
        ...(a.star_rating ? { starRating: { "@type": "Rating", ratingValue: a.star_rating } } : {}),
      },
      {
        "@type": "FAQPage",
        mainEntity: a.faq.map((f) => ({
          "@type": "Question",
          name: f.q,
          acceptedAnswer: { "@type": "Answer", text: f.a },
        })),
      },
    ],
  };
  // Prevent "</script>" inside strings from closing the tag.
  const ld = JSON.stringify(jsonLd).replace(/</g, "\\u003c");

  return `<p><em>${e(a.summary)}</em></p>
<!--more-->
<h2>Address &amp; Contact: ${e(a.hotel_name)}</h2>
<table class="hotel-info"><tbody>
${infoRows.join("\n")}
</tbody></table>

${safeBody}

<h2>Location Map</h2>
<div class="hotel-map" style="position:relative;width:100%;padding-bottom:56%;height:0;overflow:hidden;">
<iframe src="${mapEmbed}" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;" loading="lazy" referrerpolicy="no-referrer-when-downgrade" title="Map of ${e(a.hotel_name)}"></iframe>
</div>

<h2>Frequently Asked Questions</h2>
${faqHtml}

<script type="application/ld+json">${ld}</script>`;
}
