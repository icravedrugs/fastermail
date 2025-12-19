import type { VercelRequest, VercelResponse } from "@vercel/node";
import { initServices, verifyCronSecret, type Services } from "../lib/init.js";
import { buildConfigFromStore } from "../../src/triage/rules.js";
import type { Email } from "../../src/jmap/index.js";
import type { Classification } from "../../src/triage/classifier.js";
import type { ProcessedEmail } from "../../src/db/index.js";

interface TriageResult {
  emailId: string;
  classification: Classification;
  confidence: number;
  reasoning: string;
  labelsApplied: string[];
  actionTaken: "labeled" | "archived" | "kept";
}

async function processEmail(
  email: Email,
  services: Services
): Promise<TriageResult> {
  const { jmap, store, profileManager, classifier, labelManager, config } = services;
  const classifierConfig = await buildConfigFromStore(store);
  const fromEmail = email.from?.[0]?.email;

  // Get sender profile
  let senderProfile = null;
  if (fromEmail) {
    senderProfile = await profileManager.getProfile(fromEmail);
    await profileManager.recordIncomingEmail(fromEmail);
  }

  // Classify
  const classification = await classifier.classify(
    email,
    senderProfile,
    classifierConfig
  );

  // Apply labels
  const labelsApplied: string[] = [classification.classification];
  await labelManager.applyClassificationLabel(
    email.id,
    classification.classification
  );

  // Apply suggested labels
  for (const label of classification.suggestedLabels.slice(0, 3)) {
    await labelManager.applyCustomLabel(email.id, label);
    labelsApplied.push(label);
  }

  // Flag important emails
  if (classification.classification === "important") {
    await labelManager.flagAsImportant(email.id);
  }

  // Determine action
  let actionTaken: "labeled" | "archived" | "kept" = "labeled";

  if (config.mode === "triage") {
    if (classification.classification === "low-priority") {
      await jmap.archiveEmail(email.id);
      actionTaken = "archived";
    } else {
      actionTaken = "kept";
    }
  }

  // Save to database
  const processed: ProcessedEmail = {
    id: email.id,
    threadId: email.threadId,
    fromEmail: email.from?.[0]?.email || "unknown",
    fromName: email.from?.[0]?.name || null,
    subject: email.subject,
    receivedAt: email.receivedAt,
    processedAt: new Date().toISOString(),
    classification: classification.classification,
    confidence: classification.confidence,
    reasoning: classification.reasoning,
    labelsApplied: labelsApplied.join(","),
    actionTaken,
    contentFormat: classification.contentFormat,
  };

  await store.saveProcessedEmail(processed);

  console.log(
    `  [${classification.classification}] ${email.subject?.slice(0, 50) || "(no subject)"} (${Math.round(classification.confidence * 100)}%)`
  );

  return {
    emailId: email.id,
    classification: classification.classification,
    confidence: classification.confidence,
    reasoning: classification.reasoning,
    labelsApplied,
    actionTaken,
  };
}

async function processNewEmails(services: Services): Promise<TriageResult[]> {
  const { jmap, store, labelManager, correctionProcessor } = services;

  // Process any pending corrections first
  const correctionsProcessed = await correctionProcessor.processAllCorrections();
  if (correctionsProcessed > 0) {
    console.log(`Applied ${correctionsProcessed} user corrections`);
  }

  // Find inbox
  const inbox = await jmap.findMailboxByRole("inbox");
  if (!inbox) {
    throw new Error("Inbox mailbox not found");
  }

  // Get emails from inbox
  const emailIds = await jmap.queryEmails(
    { inMailbox: inbox.id },
    { limit: 500, sort: [{ property: "receivedAt", isAscending: false }] }
  );

  // Filter to only unprocessed emails
  const unprocessedIds: string[] = [];
  for (const id of emailIds) {
    const isProcessed = await store.isEmailProcessed(id);
    if (!isProcessed) {
      unprocessedIds.push(id);
    }
  }

  if (unprocessedIds.length === 0) {
    return [];
  }

  // Process in batches of 50
  const batchSize = 50;
  const idsToProcess = unprocessedIds.slice(0, batchSize);

  console.log(`Processing ${idsToProcess.length} new emails (${unprocessedIds.length} total unprocessed)...`);

  // Fetch full email data
  const emails = await jmap.getEmails(idsToProcess);

  // Filter out emails that already have classification labels
  const emailsToProcess = emails.filter(
    (email) => !labelManager.hasAnyClassificationMailbox(email.mailboxIds)
  );

  if (emailsToProcess.length === 0) {
    // Mark as processed even if we skipped them
    for (const email of emails) {
      const processed: ProcessedEmail = {
        id: email.id,
        threadId: email.threadId,
        fromEmail: email.from?.[0]?.email || "unknown",
        fromName: email.from?.[0]?.name || null,
        subject: email.subject,
        receivedAt: email.receivedAt,
        processedAt: new Date().toISOString(),
        classification: "fyi",
        confidence: 1,
        reasoning: "Already labeled",
        labelsApplied: null,
        actionTaken: "labeled",
        contentFormat: "standard",
      };
      await store.saveProcessedEmail(processed);
    }
    return [];
  }

  // Process each email
  const results: TriageResult[] = [];

  for (const email of emailsToProcess) {
    try {
      const result = await processEmail(email, services);
      results.push(result);
    } catch (error) {
      console.error(`Failed to process email ${email.id}:`, error);
    }
  }

  console.log(`Processed ${results.length} emails`);
  return results;
}

export const config = {
  maxDuration: 60,
};

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Only allow GET requests
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Verify cron secret
  if (!verifyCronSecret(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    console.log("Triage cron triggered");
    const services = await initServices();
    const results = await processNewEmails(services);

    res.status(200).json({
      success: true,
      processed: results.length,
      results: results.map((r) => ({
        emailId: r.emailId,
        classification: r.classification,
        action: r.actionTaken,
      })),
    });
  } catch (error) {
    console.error("Triage cron error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
