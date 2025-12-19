export interface ExtractedLink {
  title: string;
  url: string;
}

// Patterns to filter out non-content links
const SKIP_PATTERNS = [
  /unsubscribe/i,
  /opt[_-]?out/i,
  /manage[_-]?preferences/i,
  /email[_-]?preferences/i,
  /privacy[_-]?policy/i,
  /terms[_-]?of[_-]?service/i,
  /view[_-]?in[_-]?browser/i,
  /view[_-]?online/i,
  /update[_-]?profile/i,
  /forward[_-]?to[_-]?friend/i,
  /mailto:/i,
  /^#/,  // Anchor links
  /^javascript:/i,
  /facebook\.com/i,
  /twitter\.com/i,
  /x\.com\/share/i,
  /linkedin\.com\/share/i,
  /instagram\.com/i,
  /youtube\.com\/(channel|user)/i,
  /t\.co\//i,  // Twitter shortlinks to their own site
];

// Common footer/nav link texts to skip
const SKIP_TEXTS = [
  "unsubscribe",
  "manage preferences",
  "view in browser",
  "privacy policy",
  "terms of service",
  "contact us",
  "follow us",
  "share",
  "tweet",
  "forward",
  "©",
  "copyright",
];

// Extract href value from an anchor tag
function extractHref(anchorTag: string): string | null {
  const match = anchorTag.match(/href\s*=\s*["']([^"']+)["']/i);
  return match ? match[1] : null;
}

// Extract link text from an anchor tag (text between <a> and </a>)
function extractLinkText(anchorTag: string, fullMatch: string): string {
  // Try to get text content, stripping inner HTML tags
  const textMatch = fullMatch.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
  if (textMatch) {
    // Strip any inner HTML tags and decode entities
    let text = textMatch[1]
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
    return text;
  }
  return "";
}

// Check if a URL should be skipped
function shouldSkipUrl(url: string): boolean {
  return SKIP_PATTERNS.some((pattern) => pattern.test(url));
}

// Check if link text indicates a skip
function shouldSkipText(text: string): boolean {
  const lower = text.toLowerCase();
  return SKIP_TEXTS.some((skip) => lower.includes(skip));
}

// Check if URL is a tracking/redirect URL (common in newsletters)
function isTrackingUrl(url: string): boolean {
  // Common tracking URL patterns
  const trackingPatterns = [
    /click\./i,
    /track\./i,
    /links\./i,
    /redirect\./i,
    /r\..*\.com/i,
    /email\..*\.com\/.*click/i,
    /list-manage\.com/i,
    /mailchimp\.com/i,
  ];
  return trackingPatterns.some((p) => p.test(url));
}

// Normalize and validate URL
function normalizeUrl(url: string, baseUrl?: string): string | null {
  try {
    // Handle relative URLs
    if (url.startsWith("/") && baseUrl) {
      const base = new URL(baseUrl);
      return `${base.protocol}//${base.host}${url}`;
    }

    // Validate absolute URLs
    if (url.startsWith("http://") || url.startsWith("https://")) {
      new URL(url); // Validate
      return url;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Extract content links from HTML email body.
 * Filters out navigation, footer, social, and tracking links.
 */
export function extractLinks(html: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const seenUrls = new Set<string>();

  // Match anchor tags with their content
  const anchorRegex = /<a\s[^>]*href\s*=\s*["'][^"']+["'][^>]*>[\s\S]*?<\/a>/gi;
  let match;

  while ((match = anchorRegex.exec(html)) !== null) {
    const fullMatch = match[0];
    const href = extractHref(fullMatch);

    if (!href) continue;

    // Skip non-http links
    if (!href.startsWith("http://") && !href.startsWith("https://")) continue;

    // Skip if URL matches skip patterns
    if (shouldSkipUrl(href)) continue;

    // Normalize URL
    const normalizedUrl = normalizeUrl(href);
    if (!normalizedUrl) continue;

    // Skip duplicates
    if (seenUrls.has(normalizedUrl)) continue;

    // Extract and clean link text
    const text = extractLinkText(fullMatch, fullMatch);

    // Skip if text is too short or matches skip patterns
    if (text.length < 3) continue;
    if (shouldSkipText(text)) continue;

    // Skip if text is just a URL
    if (text.startsWith("http://") || text.startsWith("https://")) continue;

    seenUrls.add(normalizedUrl);
    links.push({
      title: text,
      url: normalizedUrl,
    });
  }

  return links;
}

/**
 * Extract the most likely content links from a newsletter.
 * Returns top links that appear to be article/story links.
 */
export function extractStoryLinks(html: string, maxLinks: number = 10): ExtractedLink[] {
  const allLinks = extractLinks(html);

  // Score links by likely content relevance
  const scoredLinks = allLinks.map((link) => {
    let score = 0;

    // Longer titles are usually more descriptive
    if (link.title.length > 20) score += 2;
    if (link.title.length > 50) score += 1;

    // Links with article-like words
    if (/\b(how|why|what|guide|intro|learn|build|create|new|announce)/i.test(link.title)) {
      score += 2;
    }

    // Penalize short generic text
    if (link.title.length < 10) score -= 2;
    if (/^(read|click|here|more|link|view)$/i.test(link.title)) score -= 3;

    // Penalize tracking URLs (lower quality)
    if (isTrackingUrl(link.url)) score -= 1;

    return { link, score };
  });

  // Sort by score descending, then return top N
  scoredLinks.sort((a, b) => b.score - a.score);

  return scoredLinks.slice(0, maxLinks).map((s) => s.link);
}
