/**
 * Normalize an article URL for deduplication.
 *
 * Two URLs that point at the same article should produce the same normalized
 * form so we can detect duplicates across newsletters and recap emails:
 *   - lowercase host, strip leading "www."
 *   - drop fragments and trailing slashes
 *   - drop common tracking query params (utm_*, fbclid, ref, source, …)
 *   - sort remaining params for stable comparison
 *
 * Returns the lowercased trimmed input if parsing fails, so the result is
 * always a string suitable for an equality check.
 */
const TRACKING_KEYS = new Set([
  "ref",
  "ref_src",
  "ref_url",
  "source",
  "src",
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "msclkid",
  "trk",
  "yclid",
  "vero_id",
  "vero_conv",
  "_hsenc",
  "_hsmi",
  "hsctatracking",
  "redirect",
  "subscriber_id",
  "subs_id",
  "email_id",
  "user_id",
  "uuid",
  "signature",
  "user_email",
  "encoded_url",
  "j",
  "r",
  "token",
  "iat",
  "exp",
]);

const TRACKING_PREFIXES = ["utm_", "_ga", "mtm_"];

export function normalizeArticleUrl(url: string): string {
  try {
    const parsed = new URL(url);
    let host = parsed.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);

    const params: [string, string][] = [];
    for (const [key, value] of parsed.searchParams.entries()) {
      const lower = key.toLowerCase();
      if (TRACKING_KEYS.has(lower)) continue;
      if (TRACKING_PREFIXES.some((p) => lower.startsWith(p))) continue;
      params.push([key, value]);
    }
    params.sort(([a], [b]) => a.localeCompare(b));
    const search = params.length
      ? "?" + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
      : "";

    let path = parsed.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

    return `${parsed.protocol}//${host}${path}${search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}
