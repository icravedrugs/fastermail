export {
  DigestGenerator,
  type DigestConfig,
  type Digest,
  type DigestSection,
} from "./generator.js";
export { extractLinks, extractStoryLinks, type ExtractedLink } from "./link-extractor.js";
export { applySummaryStrategy, requiresEmailBody, type DigestItem } from "./strategies.js";
