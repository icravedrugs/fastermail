import Anthropic from "@anthropic-ai/sdk";
import type { Email } from "../jmap/index.js";
import type { ReaderProfile } from "./profile.js";
import { extractLinks, type ExtractedLink } from "../digest/link-extractor.js";
import type { ItemTier, TierCorrection } from "../db/index.js";

export interface ExtractedNewsletterItem {
  url: string;
  title: string;
  description: string;
  tier: ItemTier;
  topic: string;
  confidence: number;
  reason: string;
  softSkip: boolean; // true = off-profile but not objectionable, eligible for exploration
  readerWorthy: boolean; // false = not article-like content, should stay as email
  author: string | null; // extracted author name from the content body
}

/**
 * Get HTML content from an email body
 */
function getEmailBodyHtml(email: Email): string | null {
  if (!email.bodyValues || !email.htmlBody) return null;
  for (const part of email.htmlBody) {
    if (part.partId && email.bodyValues[part.partId]) {
      return email.bodyValues[part.partId].value;
    }
  }
  return null;
}

/**
 * Get text content from an email body
 */
function getEmailBodyText(email: Email): string {
  if (!email.bodyValues) return email.preview || "";

  if (email.textBody) {
    for (const part of email.textBody) {
      if (part.partId && email.bodyValues[part.partId]) {
        return email.bodyValues[part.partId].value;
      }
    }
  }

  if (email.htmlBody) {
    for (const part of email.htmlBody) {
      if (part.partId && email.bodyValues[part.partId]) {
        const html = email.bodyValues[part.partId].value;
        return html
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/\s+/g, " ")
          .trim();
      }
    }
  }

  return email.preview || "";
}

/**
 * Try to extract a "view in browser" URL from newsletter HTML.
 * Many newsletters include this as a fallback link.
 */
export function extractViewInBrowserUrl(html: string): string | null {
  const patterns = [
    /href\s*=\s*["']([^"']+)["'][^>]*>[\s\S]*?view\s+(?:in\s+)?(?:browser|online|web)/i,
    /href\s*=\s*["']([^"']+)["'][^>]*>[\s\S]*?read\s+(?:in\s+)?(?:browser|online|web)/i,
    /href\s*=\s*["']([^"']+)["'][^>]*>[\s\S]*?open\s+in\s+browser/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1].startsWith("http")) {
      return match[1];
    }
  }

  return null;
}

/**
 * Resolve a single redirect/tracking URL to its final destination.
 * Follows redirects safely (SSRF-protected) and returns the resolved URL,
 * or the original URL if resolution fails.
 */
export async function resolveRedirectUrl(url: string): Promise<string> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const location = response.headers.get("location");
    if (location && location.startsWith("https://")) {
      // Follow one more hop if needed
      try {
        const controller2 = new AbortController();
        const timeout2 = setTimeout(() => controller2.abort(), 5000);
        const response2 = await fetch(location, {
          method: "HEAD",
          redirect: "manual",
          signal: controller2.signal,
        });
        clearTimeout(timeout2);
        const location2 = response2.headers.get("location");
        if (location2 && location2.startsWith("https://")) {
          return location2;
        }
      } catch {
        // One hop was enough
      }
      return location;
    }
  } catch {
    // Keep original URL on failure
  }
  return url;
}

/**
 * Resolve redirect/tracking URLs to their actual destinations.
 * Reuses the same SSRF-safe approach from strategies.ts.
 */
async function resolveRedirectUrls(
  links: ExtractedLink[]
): Promise<ExtractedLink[]> {
  const allowedRedirectDomains = [
    "substack.com",
    "list-manage.com",
    "mailchimp.com",
    "convertkit.com",
    "sendinblue.com",
    "brevo.com",
    "mailgun.net",
    "sendgrid.net",
    "constantcontact.com",
    "campaign-archive.com",
    "marginalrevolution.com",
    "beehiiv.com",
    "wordpress.com",
    "wp.com",
    "safelinks.protection.outlook.com",
    "links.morningbrew.com",
    "link.mail.beehiiv.com",
    "email.mg.substack.com",
    "click.convertkit-mail.com",
    "click.convertkit-mail2.com",
    "trk.klclick.com",
    "links.tldrnewsletter.com",
    "tracking.tldrnewsletter.com",
    "alphasignal.ai",
    "app.alphasignal.ai",
  ];

  function isAllowedRedirectUrl(url: string): boolean {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return allowedRedirectDomains.some(
        (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
      );
    } catch {
      return false;
    }
  }

  function isSafePublicUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") return false;
      const hostname = parsed.hostname.toLowerCase();
      if (
        hostname === "localhost" ||
        hostname.startsWith("127.") ||
        hostname.startsWith("10.") ||
        hostname.startsWith("192.168.") ||
        hostname === "[::1]" ||
        hostname.startsWith("169.254.") ||
        hostname.startsWith("0.")
      ) {
        return false;
      }
      if (hostname.startsWith("172.")) {
        const second = parseInt(hostname.split(".")[1], 10);
        if (second >= 16 && second <= 31) return false;
      }
      if (hostname === "metadata.google.internal") return false;
      return true;
    } catch {
      return false;
    }
  }

  const needsResolving = links.some((link) => isAllowedRedirectUrl(link.url));
  if (!needsResolving) return links;

  const resolved = await Promise.all(
    links.map(async (link) => {
      if (!isAllowedRedirectUrl(link.url)) return link;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        let response = await fetch(link.url, {
          method: "HEAD",
          redirect: "manual",
          signal: controller.signal,
        });
        // Some services (AlphaSignal) block HEAD but allow GET
        if (response.status === 403) {
          const controller2 = new AbortController();
          const timeout2 = setTimeout(() => controller2.abort(), 5000);
          response = await fetch(link.url, {
            method: "GET",
            redirect: "manual",
            signal: controller2.signal,
          });
          clearTimeout(timeout2);
        }
        clearTimeout(timeout);
        const location = response.headers.get("location");
        if (location && isSafePublicUrl(location)) {
          return { ...link, url: location };
        }
      } catch {
        // Keep original URL on failure
      }
      return link;
    })
  );

  return resolved;
}

/**
 * Build the corrections context for the LLM prompt.
 */
function buildCorrectionsContext(
  corrections: (TierCorrection & { itemUrl: string; itemTitle: string | null; newsletterFrom: string })[]
): string {
  if (corrections.length === 0) return "";

  const examples = corrections
    .slice(0, 10)
    .map(
      (c) =>
        `- "${c.itemTitle || c.itemUrl}" from ${c.newsletterFrom}: was ${c.originalTier}, should be ${c.correctedTier}`
    )
    .join("\n");

  return `
LEARNED FROM USER CORRECTIONS (apply these patterns to similar items):
${examples}
`;
}

/**
 * Extract links/items from a newsletter and classify each by relevance tier.
 * Single-pass LLM call that both identifies content links and assigns tiers.
 */
export async function extractAndClassifyItems(
  emailBody: Email,
  profile: ReaderProfile,
  corrections: (TierCorrection & { itemUrl: string; itemTitle: string | null; newsletterFrom: string })[],
  client: Anthropic
): Promise<ExtractedNewsletterItem[]> {
  const html = getEmailBodyHtml(emailBody);
  const emailText = getEmailBodyText(emailBody);
  const subject = emailBody.subject || "";

  // For newsletters with HTML and links, extract and classify
  if (html) {
    const rawLinks = extractLinks(html);

    if (rawLinks.length > 0) {
      const resolvedLinks = await resolveRedirectUrls(rawLinks);
      return await classifyLinksWithLLM(
        resolvedLinks,
        emailText,
        subject,
        profile,
        corrections,
        client
      );
    }

    // Essay-style newsletter with no external links
    // Classify the essay's relevance so the engine can decide whether to forward it
    return await classifyEssayNewsletter(
      emailText,
      subject,
      profile,
      client
    );
  }

  // Fallback: no extractable content
  return [];
}

/**
 * Use LLM to identify curated content links and classify each by relevance tier.
 */
async function classifyLinksWithLLM(
  links: ExtractedLink[],
  emailText: string,
  subject: string,
  profile: ReaderProfile,
  corrections: (TierCorrection & { itemUrl: string; itemTitle: string | null; newsletterFrom: string })[],
  client: Anthropic
): Promise<ExtractedNewsletterItem[]> {
  const linkList = links
    .map((link, i) => `${i + 1}. "${link.title}" -> ${link.url}`)
    .join("\n");

  const topicList = profile.topicVocabulary.length > 0
    ? profile.topicVocabulary.join(", ")
    : "general";

  const correctionsContext = buildCorrectionsContext(corrections);

  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: `You are analyzing a newsletter email to extract valuable content and classify it by relevance.

READER PROFILE:
${profile.raw}

TOPIC VOCABULARY (assign one of these as the topic tag, or create a short new one if nothing fits):
${topicList}
${correctionsContext}
From the list of links below, identify ONLY the links that point to curated articles, stories, or external content.

EXCLUDE:
- Navigation links (homepage, signup, login, "read on blog")
- Social media links (follow on X/Twitter, YouTube, Instagram)
- Unsubscribe, manage preferences, view in browser
- Author byline links, "about us", "advertise"
- Feedback/rating links
- Self-referential links (link to the newsletter itself)

First, determine if each link points to something worth reading in a reader app (an article, essay, analysis, tutorial, or curated content). Links that point to non-article content — account updates, fund reports, community posts, product changelogs, patch notes, shipping notifications, event invites, surveys — are NOT reader-worthy and should always be "skip-hard" regardless of topic relevance.

For reader-worthy content links, classify relevance to the reader:
- "must-read": Directly relevant to the reader's current work, focus areas, or core interests. They need to see this.
- "nice-to-have": Interesting, touches on adjacent interests or curiosities. Worth saving but not urgent.
- "skip-soft": Not directly relevant right now, but not objectionable. Could be interesting, surprising, or culturally enriching. The reader might enjoy stumbling across it.
- "skip-hard": Actively irrelevant. Matches the reader's low-value topics or is clearly outside any interest. Do not surface.

EMAIL SUBJECT: ${subject}

EMAIL TEXT (first 3000 chars):
${emailText.slice(0, 3000)}

EXTRACTED LINKS:
${linkList}

Respond with ONLY a JSON array, no other text:
[{"index": 1, "title": "Clean descriptive title", "description": "One sentence about the content", "tier": "must-read", "topic": "topic-tag", "confidence": 0.9, "reason": "Why this tier was assigned"}, ...]

Use "skip-soft" for content that is off-topic but has genuine appeal (cool visuals, surprising ideas, cultural depth). Use "skip-hard" for noise.

If no curated content links are found, respond with: []`,
      },
    ],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  if (!text) return [];

  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      index: number;
      title: string;
      description: string;
      tier: string;
      topic: string;
      confidence: number;
      reason: string;
    }>;

    const seen = new Set<string>();
    return parsed
      .filter((item) => item.index >= 1 && item.index <= links.length)
      .map((item) => {
        const { tier, softSkip } = parseTier(item.tier);
        return {
          url: links[item.index - 1].url,
          title: item.title || links[item.index - 1].title,
          description: item.description || "",
          tier,
          topic: item.topic || "general",
          confidence: typeof item.confidence === "number" ? item.confidence : 0.5,
          reason: item.reason || "",
          softSkip,
          readerWorthy: true, // links that survive filtering are reader-worthy by definition
          author: null,
        };
      })
      .filter((item) => {
        if (seen.has(item.url)) return false;
        seen.add(item.url);
        return true;
      });
  } catch (error) {
    console.error("Failed to parse LLM newsletter extraction response:", error);
    return [];
  }
}

/**
 * Classify an essay-style newsletter (no external links) as a single item.
 */
async function classifyEssayNewsletter(
  emailText: string,
  subject: string,
  profile: ReaderProfile,
  client: Anthropic
): Promise<ExtractedNewsletterItem[]> {
  const topicList = profile.topicVocabulary.length > 0
    ? profile.topicVocabulary.join(", ")
    : "general";

  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 500,
    messages: [
      {
        role: "user",
        content: `You are classifying a newsletter email for a reader.

READER PROFILE:
${profile.raw}

TOPIC VOCABULARY: ${topicList}

NEWSLETTER SUBJECT: ${subject}

CONTENT (first 3000 chars):
${emailText.slice(0, 3000)}

First, determine if this is READER-WORTHY — meaning it contains article-like content (essays, analysis, opinion pieces, tutorials, long-form writing) that benefits from being read in a reader app.

NOT reader-worthy: account updates, patron/membership updates, fund reports, community posts, product changelogs, event invites/RSVPs/AMAs, shipping notifications, surveys, short status updates, promotional emails, donation appeals, or any email under ~300 words that is primarily a call-to-action rather than substantive writing. These should stay as regular emails.

If reader-worthy, classify relevance to the reader:
- "must-read": Directly relevant to their work or core interests
- "nice-to-have": Interesting but not urgent
- "skip-soft": Not directly relevant but could be interesting or surprising
- "skip-hard": Actively irrelevant, matches low-value topics

Also extract the AUTHOR — the person who actually wrote this content. Look for bylines, signatures, or "by [name]" patterns in the text. This is often different from the newsletter brand name (e.g., "Tyler Cowen" not "Marginal Revolution", "Molly Webster" not "Radiolab"). If multiple authors, list them comma-separated. If you can't identify a specific person, return null.

Respond with ONLY a JSON object:
{"title": "Clean title", "description": "One sentence summary", "author": "Author Name", "readerWorthy": true, "tier": "must-read", "topic": "topic-tag", "confidence": 0.9, "reason": "Why this tier"}

If NOT reader-worthy, set readerWorthy to false and tier to "skip-hard".`,
      },
    ],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  if (!text) return [];

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as {
      title: string;
      description: string;
      author?: string | null;
      readerWorthy?: boolean;
      tier: string;
      topic: string;
      confidence: number;
      reason: string;
    };

    const readerWorthy = parsed.readerWorthy !== false;
    const { tier, softSkip } = parseTier(parsed.tier);
    return [
      {
        url: "", // Essay newsletters are saved via API, not by URL
        title: parsed.title || subject,
        description: parsed.description || "",
        tier: readerWorthy ? tier : "skip",
        topic: parsed.topic || "general",
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
        reason: parsed.reason || "",
        softSkip,
        readerWorthy,
        author: parsed.author || null,
      },
    ];
  } catch (error) {
    console.error("Failed to parse LLM essay classification response:", error);
    return [];
  }
}

function parseTier(tier: string): { tier: ItemTier; softSkip: boolean } {
  if (tier === "must-read" || tier === "nice-to-have") {
    return { tier, softSkip: false };
  }
  if (tier === "skip-soft") {
    return { tier: "skip", softSkip: true };
  }
  if (tier === "skip-hard" || tier === "skip") {
    return { tier: "skip", softSkip: false };
  }
  return { tier: "nice-to-have", softSkip: false };
}
