import type { Store, NewsletterItem, ReadingFeedback } from "../db/index.js";
import type { ReadwiseClient } from "../readwise/index.js";

const READWISE_BASE_URL = "https://readwise.io/api/v3";

/**
 * Extract the tier from a list of Readwise tags (e.g., ["tier:must-read", "src:foo"])
 */
function extractTierFromTags(tags: string[]): string | null {
  for (const tag of tags) {
    if (tag.startsWith("tier:")) {
      return tag.slice(5); // "tier:must-read" -> "must-read"
    }
  }
  return null;
}

export async function processWebhookEvent(
  event: {
    type: string;
    document_id?: string;
    reading_progress?: number;
    highlight_text?: string;
    tags?: string[];
    timestamp?: string;
  },
  store: Store
): Promise<{ processed: boolean; reason: string }> {
  const docId = event.document_id;
  if (!docId) {
    return { processed: false, reason: "no document_id in event" };
  }

  const item = await store.getItemByReadwiseDocId(docId);
  if (!item) {
    return { processed: false, reason: "not a fastermail item" };
  }

  const now = event.timestamp ?? new Date().toISOString();

  switch (event.type) {
    case "reader.document.finished":
      await store.saveReadingFeedback({
        itemId: item.id,
        readwiseDocId: docId,
        signalType: "document_finished",
        readingProgress: event.reading_progress ?? null,
        highlightedText: null,
        eventTimestamp: now,
      });
      return { processed: true, reason: "recorded finish" };

    case "readwise.highlight.created":
      await store.saveReadingFeedback({
        itemId: item.id,
        readwiseDocId: docId,
        signalType: "highlight_created",
        readingProgress: null,
        highlightedText: event.highlight_text ?? null,
        eventTimestamp: now,
      });
      return { processed: true, reason: "recorded highlight" };

    case "reader.document.tags_updated": {
      // Detect tier change from Readwise tag edits
      if (!event.tags) {
        return { processed: false, reason: "no tags in event" };
      }
      const newTier = extractTierFromTags(event.tags);
      if (!newTier || newTier === item.tier) {
        return { processed: false, reason: "no tier change detected" };
      }
      // Valid tier values
      if (newTier !== "must-read" && newTier !== "nice-to-have" && newTier !== "skip") {
        return { processed: false, reason: `unknown tier: ${newTier}` };
      }
      // Save as a tier correction (same as the web UI)
      await store.saveTierCorrection({
        itemId: item.id,
        originalTier: item.tier,
        correctedTier: newTier as any,
      });
      await store.updateNewsletterItemTier(item.id, newTier as any);
      console.log(`[webhook] Tier correction from Readwise: "${item.title?.slice(0, 40)}" ${item.tier} → ${newTier}`);
      return { processed: true, reason: `tier corrected to ${newTier}` };
    }

    case "reader.document.deleted": {
      // User deleted from Readwise = demotion to skip
      if (item.tier === "skip") {
        return { processed: false, reason: "already skip" };
      }
      await store.saveTierCorrection({
        itemId: item.id,
        originalTier: item.tier,
        correctedTier: "skip",
      });
      await store.updateNewsletterItemTier(item.id, "skip");
      await store.updateNewsletterItemReadwise(item.id, "pending", null, 0, null);
      console.log(`[webhook] Deleted from Readwise: "${item.title?.slice(0, 40)}" → skip`);
      return { processed: true, reason: "demoted to skip (deleted in Readwise)" };
    }

    default:
      return { processed: false, reason: `unhandled event type: ${event.type}` };
  }
}

export async function computeExplorationRate(
  store: Store,
  baseRate: number = 0.10
): Promise<number> {
  const summary = await store.getFeedbackSummary(30);

  const totalWithFeedback =
    summary.totalHighlights + summary.totalFinished;

  if (totalWithFeedback < 10) {
    return baseRate;
  }

  let rate = baseRate;

  // If nice-to-have items account for >20% of all highlights, user is
  // finding value in exploration-adjacent content — increase the rate.
  if (summary.totalHighlights > 0) {
    const niceToHaveHighlights = summary.highlightsByTier["nice-to-have"] ?? 0;
    if (niceToHaveHighlights / summary.totalHighlights > 0.2) {
      rate += 0.05;
    }
  }

  // If more than half of must-reads are going unread, the user is
  // overwhelmed — pull back on exploration so we don't pile on.
  const totalMustReads =
    (summary.highlightsByTier["must-read"] ?? 0) + summary.unreadMustReads;
  if (totalMustReads > 0 && summary.unreadMustReads / totalMustReads > 0.5) {
    rate -= 0.03;
  }

  return Math.max(0.03, Math.min(0.25, rate));
}

export async function generateFeedbackDigestSection(
  store: Store
): Promise<string | null> {
  const summary = await store.getFeedbackSummary(30);

  if (summary.totalHighlights === 0 && summary.totalFinished === 0) {
    return null;
  }

  const lines: string[] = [];

  lines.push(
    `Reading activity (last 30 days): ${summary.totalHighlights} items highlighted, ${summary.totalFinished} finished reading`
  );

  const topicEntries = Object.entries(summary.highlightsByTopic);
  if (topicEntries.length > 0) {
    const topTopics = topicEntries
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([topic]) => topic);
    lines.push(`Most highlighted topics: ${topTopics.join(", ")}`);
  }

  if (summary.unreadMustReads > 3) {
    lines.push(
      `Note: ${summary.unreadMustReads} must-read items from 14+ days ago haven't been opened`
    );
  }

  if (summary.readNiceToHaves > 0) {
    lines.push(
      `${summary.readNiceToHaves} nice-to-have items got read — consider promoting those topics`
    );
  }

  return lines.join("\n");
}

export async function pollReadingProgress(
  store: Store,
  readwiseToken: string
): Promise<{ checked: number; signals: number }> {
  const items = await store.getItemsForProgressCheck();

  let checked = 0;
  let signals = 0;
  const MAX_PER_CYCLE = 20;

  for (const item of items.slice(0, MAX_PER_CYCLE)) {
    if (!item.readwiseDocId) continue;

    checked++;

    // TODO: Replace with a proper ReadwiseClient.list() method once available.
    // For now, call the Readwise list API directly with raw fetch.
    const response = await fetch(
      `${READWISE_BASE_URL}/list/?id=${item.readwiseDocId}`,
      {
        headers: {
          Authorization: `Token ${readwiseToken}`,
        },
      }
    );

    if (!response.ok) continue;

    const data = (await response.json()) as {
      results?: Array<{
        reading_progress: number;
        first_opened_at: string | null;
      }>;
    };

    const doc = data.results?.[0];
    if (!doc) continue;

    if (doc.reading_progress > 0.5) {
      await store.saveReadingFeedback({
        itemId: item.id,
        readwiseDocId: item.readwiseDocId,
        signalType: "progress_update",
        readingProgress: doc.reading_progress,
        highlightedText: null,
        eventTimestamp: new Date().toISOString(),
      });
      signals++;
    }

    // If never opened after 14 days, record as a weak negative signal
    const daysSinceSaved =
      (Date.now() - new Date(item.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    if (doc.first_opened_at === null && daysSinceSaved >= 14) {
      await store.saveReadingFeedback({
        itemId: item.id,
        readwiseDocId: item.readwiseDocId,
        signalType: "progress_update",
        readingProgress: 0,
        highlightedText: null,
        eventTimestamp: new Date().toISOString(),
      });
      signals++;
    }
  }

  return { checked, signals };
}
