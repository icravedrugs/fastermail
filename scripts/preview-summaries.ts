/**
 * Preview how email summaries would look with the new contentSummary changes.
 * This script re-classifies past emails and shows what the digest would display.
 *
 * Usage: npx tsx scripts/preview-summaries.ts
 */

import "dotenv/config";
import { createClient } from "@libsql/client";
import { Store, type DigestRecord } from "../src/db/store.js";
import { JMAPClient } from "../src/jmap/client.js";
import { EmailClassifier, type ClassifierConfig } from "../src/triage/classifier.js";
import { extractLinksWithContext, type ExtractedLink } from "../src/digest/link-extractor.js";

async function getRecentDigests(store: Store, count: number = 3): Promise<DigestRecord[]> {
  // Query recent sent/cleaned digests
  const db = (store as unknown as { db: ReturnType<typeof createClient> }).db;
  const result = await db.execute({
    sql: `SELECT * FROM digests
          WHERE status IN ('sent', 'cleaned')
          ORDER BY generated_at DESC
          LIMIT ?`,
    args: [count],
  });

  return result.rows.map((row) => ({
    id: row.id as number,
    cleanupToken: row.cleanup_token as string | null,
    status: row.status as "pending" | "sent" | "cleaned",
    generatedAt: row.generated_at as string | null,
    sentAt: row.sent_at as string | null,
    cleanedAt: row.cleaned_at as string | null,
    emailCount: row.email_count as number,
    summary: row.summary as string | null,
  }));
}

function getEmailBodyHtml(email: { bodyValues?: Record<string, { value: string }>; htmlBody?: Array<{ partId: string }> }): string | null {
  if (!email.bodyValues || !email.htmlBody) return null;

  for (const part of email.htmlBody) {
    if (part.partId && email.bodyValues[part.partId]) {
      return email.bodyValues[part.partId].value;
    }
  }

  return null;
}

async function main() {
  console.log("🔍 Preview Email Summaries\n");
  console.log("This shows how emails would appear in the digest with the new summarization.\n");

  // Check environment
  if (!process.env.TURSO_DATABASE_URL) {
    console.error("❌ TURSO_DATABASE_URL not set");
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("❌ ANTHROPIC_API_KEY not set");
    process.exit(1);
  }
  if (!process.env.JMAP_TOKEN) {
    console.error("❌ JMAP_TOKEN not set");
    process.exit(1);
  }
  if (!process.env.JMAP_SESSION_URL) {
    console.error("❌ JMAP_SESSION_URL not set");
    process.exit(1);
  }

  // 1. Connect to DB
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  const store = new Store(db);

  // 2. Connect to JMAP
  const jmap = new JMAPClient(process.env.JMAP_SESSION_URL, process.env.JMAP_TOKEN);
  await jmap.connect();

  // 3. Create classifier
  const classifier = new EmailClassifier(process.env.ANTHROPIC_API_KEY);
  const classifierConfig: ClassifierConfig = {
    vipSenders: [],
    autoArchiveDomains: [],
    customRules: [],
    corrections: [],
  };

  // 4. Get recent digests
  const digests = await getRecentDigests(store, 3);
  console.log(`Found ${digests.length} recent digests\n`);

  if (digests.length === 0) {
    console.log("No digests found.");
    process.exit(0);
  }

  // 5. Process each digest
  for (const digest of digests) {
    console.log("═".repeat(60));
    console.log(`📬 Digest #${digest.id}`);
    console.log(`   Generated: ${digest.generatedAt}`);
    console.log(`   Status: ${digest.status}`);
    console.log("═".repeat(60));

    const emails = await store.getEmailsByDigestId(digest.id);
    console.log(`   ${emails.length} emails\n`);

    // Filter to low-priority/fyi (what appears in digest)
    const digestEmails = emails.filter(
      (e) => e.classification === "low-priority" || e.classification === "fyi"
    );

    for (const email of digestEmails) {
      console.log(`\n📧 ${email.subject || "(no subject)"}`);
      console.log(`   From: ${email.fromName || email.fromEmail}`);
      console.log(`   Classification: ${email.classification}`);
      console.log(`   Content Format: ${email.contentFormat}`);
      console.log("   ─".repeat(30));

      try {
        // Fetch full email from JMAP to re-classify
        const fullEmails = await jmap.getEmails([email.id]);

        if (fullEmails.length === 0) {
          console.log("   ⚠️  Email not found in JMAP (may have been deleted)");
          continue;
        }

        const fullEmail = fullEmails[0];

        // Re-classify to get new contentSummary
        console.log("   🔄 Re-classifying with new prompt...");
        const result = await classifier.classify(fullEmail, null, classifierConfig);

        console.log(`\n   📝 NEW SUMMARY:`);
        console.log(`   ${result.contentSummary || "(no summary generated)"}`);

        // For link_collection, also extract links with descriptions
        if (result.contentFormat === "link_collection") {
          const emailBody = await jmap.getEmailBody(email.id);
          const html = emailBody ? getEmailBodyHtml(emailBody) : null;

          if (html) {
            const links = extractLinksWithContext(html).slice(0, 8);
            if (links.length > 0) {
              console.log(`\n   🔗 LINKS (${links.length}):`);
              for (const link of links) {
                console.log(`      • ${link.title}`);
                if (link.description) {
                  console.log(`        ${link.description}`);
                }
                console.log(`        ${link.url}`);
              }
            }
          }
        }
      } catch (err) {
        console.log(`   ❌ Error: ${err instanceof Error ? err.message : err}`);
      }
    }

    console.log("\n");
  }

  console.log("✅ Done!");
}

main().catch(console.error);
