/**
 * Simulate the newsletter intelligence pipeline on recent emails.
 * Dry run — no Readwise saves, no email moves, no DB writes.
 *
 * Usage: npx tsx scripts/simulate.ts [--limit N]
 */

import { config } from "dotenv";
config();

import { JMAPClient } from "../src/jmap/index.js";
import { createDbClient, initializeDatabase, Store } from "../src/db/index.js";
import { ProfileManager } from "../src/sender/index.js";
import { EmailClassifier } from "../src/triage/classifier.js";
import { buildConfigFromStore } from "../src/triage/rules.js";
import { ProfileLoader } from "../src/newsletter/profile.js";
import { extractAndClassifyItems } from "../src/newsletter/extractor.js";
import Anthropic from "@anthropic-ai/sdk";

const NEWSLETTER_CONFIDENCE_GATE = 0.7;

async function main() {
  const limit = parseInt(process.argv.find(a => a.startsWith("--limit="))?.split("=")[1] || "10", 10);

  console.log("Newsletter Intelligence Simulation");
  console.log("===================================");
  console.log(`Mode: DRY RUN (no saves, no moves, no Readwise)`);
  console.log(`Limit: ${limit} emails\n`);

  // Validate
  if (!process.env.JMAP_TOKEN || !process.env.ANTHROPIC_API_KEY || !process.env.TURSO_DATABASE_URL) {
    console.error("Missing required env vars: JMAP_TOKEN, ANTHROPIC_API_KEY, TURSO_DATABASE_URL");
    process.exit(1);
  }

  const profilePath = "./reader-profile.md";
  let profile;
  try {
    const loader = new ProfileLoader(profilePath);
    profile = await loader.load();
    console.log(`Reader profile loaded from ${profilePath}`);
    console.log(`  Topics: ${profile.topicVocabulary.slice(0, 5).join(", ")}...`);
  } catch (error) {
    console.error(`Failed to load reader profile from ${profilePath}:`, error);
    process.exit(1);
  }

  // Connect
  const dbClient = createDbClient();
  await initializeDatabase(dbClient);
  const store = new Store(dbClient);

  const jmap = new JMAPClient(
    process.env.JMAP_SESSION_URL || "https://api.fastmail.com/jmap/session",
    process.env.JMAP_TOKEN!
  );
  await jmap.connect();

  const userEmail = process.env.USER_EMAIL || "";
  const profileManager = new ProfileManager(store, jmap, userEmail);
  const classifier = new EmailClassifier(process.env.ANTHROPIC_API_KEY!);
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const classifierConfig = await buildConfigFromStore(store);

  // Get recent emails — pull from processed_emails that were classified as low-priority
  // (these are the ones most likely to be newsletters)
  const recentNewsletters = await store.getProcessedEmailsByClassification("low-priority", limit * 2);

  if (recentNewsletters.length === 0) {
    console.log("\nNo recent low-priority emails found in DB. Try processing some emails first.");
    process.exit(0);
  }

  console.log(`\nFound ${recentNewsletters.length} recent low-priority emails. Simulating on up to ${limit}...\n`);
  console.log("=".repeat(80));

  let processed = 0;
  let detectedAsNewsletter = 0;
  let totalItems = 0;
  let softSkipCount = 0;
  const tierCounts: Record<string, number> = { "must-read": 0, "nice-to-have": 0, "skip": 0 };

  for (const email of recentNewsletters.slice(0, limit)) {
    processed++;
    console.log(`\n[${processed}/${Math.min(limit, recentNewsletters.length)}] ${email.subject || "(no subject)"}`);
    console.log(`  From: ${email.fromName || email.fromEmail}`);
    console.log(`  Original classification: ${email.classification} (${Math.round(email.confidence * 100)}%)`);
    console.log(`  Content format: ${email.contentFormat}`);

    // Re-classify with newsletter detection
    try {
      const emails = await jmap.getEmails([email.id]);
      if (emails.length === 0) {
        console.log(`  SKIP: Email no longer exists in mailbox`);
        continue;
      }

      const senderProfile = await profileManager.getProfile(email.fromEmail);
      const result = await classifier.classify(emails[0], senderProfile, classifierConfig);

      console.log(`  Newsletter detected: ${result.isNewsletter} (${Math.round(result.newsletterConfidence * 100)}% confidence)`);

      if (!result.isNewsletter || result.newsletterConfidence < NEWSLETTER_CONFIDENCE_GATE) {
        console.log(`  → Would stay on OPERATIONAL path (not newsletter or below ${NEWSLETTER_CONFIDENCE_GATE * 100}% gate)`);
        continue;
      }

      detectedAsNewsletter++;

      // Fetch body and extract items
      let emailBody;
      try {
        emailBody = await jmap.getEmailBody(email.id);
      } catch {
        console.log(`  → Could not fetch email body (may have been deleted/archived)`);
        continue;
      }

      const items = await extractAndClassifyItems(emailBody, profile, [], anthropic);

      if (items.length === 0) {
        console.log(`  → ESSAY newsletter (no links extracted)`);
        console.log(`  → Would be FORWARDED to Readwise inbox (if configured)`);
      } else {
        console.log(`  → ${items.length} items extracted:`);
        totalItems += items.length;

        for (const item of items) {
          tierCounts[item.tier] = (tierCounts[item.tier] || 0) + 1;
          if (item.softSkip) softSkipCount++;
          const skipLabel = item.tier === "skip" ? (item.softSkip ? "soft-skip" : "hard-skip") : item.tier;
          const tierEmoji = item.tier === "must-read" ? "🟢" : item.tier === "nice-to-have" ? "🔵" : item.softSkip ? "🟡" : "⚪";
          console.log(`    ${tierEmoji} [${skipLabel}] ${item.title}`);
          if (item.description) {
            console.log(`       ${item.description}`);
          }
          console.log(`       Topic: ${item.topic} | Confidence: ${Math.round(item.confidence * 100)}%`);
          if (item.url) {
            console.log(`       URL: ${item.url}`);
          }
        }
      }

      console.log(`  → Original email would be TRASHED`);
    } catch (error) {
      console.error(`  ERROR: ${error}`);
    }
  }

  // Summary
  console.log("\n" + "=".repeat(80));
  console.log("\nSIMULATION SUMMARY");
  console.log("=".repeat(80));
  console.log(`Emails processed: ${processed}`);
  console.log(`Detected as newsletter: ${detectedAsNewsletter} (${Math.round(detectedAsNewsletter / processed * 100)}%)`);
  console.log(`Total items extracted: ${totalItems}`);
  console.log(`  🟢 Must-read: ${tierCounts["must-read"] || 0}`);
  console.log(`  🔵 Nice-to-have: ${tierCounts["nice-to-have"] || 0}`);
  console.log(`  🟡 Soft-skip: ${softSkipCount} (eligible for exploration at 10% rate)`);
  console.log(`  ⚪ Hard-skip: ${(tierCounts["skip"] || 0) - softSkipCount}`);

  if (totalItems > 0) {
    const savedCount = (tierCounts["must-read"] || 0) + (tierCounts["nice-to-have"] || 0);
    console.log(`\nWould save ${savedCount} items to Readwise (${Math.round(savedCount / totalItems * 100)}% of extracted)`);
    console.log(`Would skip ${tierCounts["skip"] || 0} items`);
  }

  console.log(`\nDone. No changes were made.`);
  process.exit(0);
}

main().catch((error) => {
  console.error("Simulation failed:", error);
  process.exit(1);
});
