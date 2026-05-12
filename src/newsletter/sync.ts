import { ReadwiseClient } from "../readwise/index.js";
import type { Store, NewsletterItem, ItemTier, ReadwiseStatus } from "../db/index.js";
import type { ExtractedNewsletterItem } from "./extractor.js";
import { computeExplorationRate } from "./feedback.js";
import { normalizeArticleUrl } from "./url-normalizer.js";

/**
 * Decide if a soft-skip item should be promoted via exploration.
 * Only applies to items the LLM marked as skip-soft (off-profile but not objectionable).
 */
function shouldExplore(item: ExtractedNewsletterItem, explorationRate: number): boolean {
  if (!item.softSkip) return false;
  if (item.tier !== "skip") return false;
  return Math.random() < explorationRate;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Save classified newsletter items to Readwise Reader.
 * Items are persisted to the DB first, then synced to Readwise.
 * Retry orchestration lives in the engine — this is a thin save-and-report layer.
 */
export async function saveItemsToReadwise(
  items: ExtractedNewsletterItem[],
  emailId: string,
  newsletterFrom: string,
  readwise: ReadwiseClient,
  store: Store
): Promise<{ saved: number; failed: number; skipped: number; duplicates: number }> {
  let saved = 0;
  let failed = 0;
  let skipped = 0;
  let duplicates = 0;

  // Compute adaptive exploration rate from reading feedback
  const explorationRate = await computeExplorationRate(store);

  // Track URLs seen within this batch — a single newsletter often lists the
  // same link twice (header card + footer roundup), and we'd otherwise
  // create two DB rows before the dedup check below fires.
  const seenInBatch = new Set<string>();

  for (const item of items) {
    // Check if this soft-skip should be promoted via exploration
    const isExploration = shouldExplore(item, explorationRate);
    const effectiveTier = isExploration ? "nice-to-have" as const : item.tier;
    const effectiveReason = isExploration
      ? `[exploration] ${item.reason}`
      : item.reason;

    // Dedup against prior batches and within the current batch.
    const normalizedUrl = normalizeArticleUrl(item.url);
    if (seenInBatch.has(normalizedUrl) || (await store.hasSeenNormalizedUrl(normalizedUrl))) {
      duplicates++;
      console.log(`  [newsletter:dup] ${item.title?.slice(0, 60)} (${item.url.slice(0, 80)})`);
      continue;
    }
    seenInBatch.add(normalizedUrl);

    // 1. Save to DB first
    const itemId = await store.saveNewsletterItem({
      emailId,
      url: item.url,
      normalizedUrl,
      title: item.title,
      description: item.description,
      tier: effectiveTier,
      topicTag: item.topic,
      confidence: item.confidence,
      reason: effectiveReason,
      readwiseStatus: effectiveTier === "skip" ? null : "pending",
      readwiseDocId: null,
      retryCount: 0,
      nextRetryAfter: null,
    });

    // 2. Skip items that don't need Readwise sync
    if (effectiveTier === "skip") {
      skipped++;
      continue;
    }

    // 3. Build Readwise save params
    const tags = [
      "tier:" + effectiveTier,
      "src:" + slugify(newsletterFrom),
      "topic:" + item.topic,
    ];
    if (isExploration) tags.push("exploration:true");

    const params = {
      url: item.url,
      title: item.title,
      tags,
      notes: effectiveReason,
      location: effectiveTier === "must-read" ? "new" as const : "later" as const,
      saved_using: "fastermail",
    };

    // 4. Try saving to Readwise
    try {
      const response = await readwise.save(params);
      await store.updateNewsletterItemReadwise(
        itemId,
        "saved",
        response.id,
        0,
        null
      );
      saved++;
    } catch (error) {
      const nextRetryAfter = new Date(Date.now() + 60_000).toISOString();
      await store.updateNewsletterItemReadwise(
        itemId,
        "failed",
        null,
        1,
        nextRetryAfter
      );
      failed++;
    }
  }

  return { saved, failed, skipped, duplicates };
}

/**
 * Retry saving previously failed items to Readwise.
 * Uses exponential backoff: 2^retryCount minutes between attempts.
 * Items are abandoned after 10 failed attempts.
 */
export async function retryFailedSaves(
  readwise: ReadwiseClient,
  store: Store
): Promise<{ saved: number; failed: number; abandoned: number }> {
  let saved = 0;
  let failed = 0;
  let abandoned = 0;

  const items = await store.getRetryableItems();

  for (const item of items) {
    // Rebuild tags from DB fields
    const tags = [
      "tier:" + item.tier,
      ...(item.topicTag ? ["topic:" + item.topicTag] : []),
    ];

    const params = {
      url: item.url,
      title: item.title ?? undefined,
      tags,
      notes: item.reason ?? undefined,
      location: item.tier === "must-read" ? "new" as const : "later" as const,
      saved_using: "fastermail",
    };

    try {
      const response = await readwise.save(params);
      await store.updateNewsletterItemReadwise(
        item.id,
        "saved",
        response.id,
        item.retryCount,
        null
      );
      saved++;
    } catch (error) {
      const newRetryCount = item.retryCount + 1;

      if (newRetryCount >= 10) {
        await store.updateNewsletterItemReadwise(
          item.id,
          "abandoned",
          null,
          newRetryCount,
          null
        );
        abandoned++;
      } else {
        const backoffMs = Math.pow(2, newRetryCount) * 60_000;
        const nextRetryAfter = new Date(Date.now() + backoffMs).toISOString();
        await store.updateNewsletterItemReadwise(
          item.id,
          "failed",
          null,
          newRetryCount,
          nextRetryAfter
        );
        failed++;
      }
    }
  }

  return { saved, failed, abandoned };
}
