import type { JMAPClient } from "../jmap/index.js";
import type { Store } from "../db/index.js";
import { LabelManager } from "../triage/labels.js";

export interface CleanupResult {
  success: boolean;
  archived: number;
  kept: number;
  deleted: number;
  alreadyCleaned: boolean;
  error?: string;
}

export async function runCleanup(
  token: string,
  jmap: JMAPClient,
  store: Store,
  labelManager: LabelManager
): Promise<CleanupResult> {
  // Find the digest by token
  const digest = await store.getDigestByToken(token);

  if (!digest) {
    return {
      success: false,
      archived: 0,
      kept: 0,
      deleted: 0,
      alreadyCleaned: false,
      error: "Invalid or expired token",
    };
  }

  if (digest.status === "cleaned") {
    return {
      success: true,
      archived: 0,
      kept: 0,
      deleted: 0,
      alreadyCleaned: true,
    };
  }

  // Get all emails associated with this digest
  const emails = await store.getEmailsByDigestId(digest.id);

  if (emails.length === 0) {
    await store.markDigestCleaned(digest.id);
    return {
      success: true,
      archived: 0,
      kept: 0,
      deleted: 0,
      alreadyCleaned: false,
    };
  }

  // Get inbox mailbox
  const inbox = await jmap.findMailboxByRole("inbox");
  if (!inbox) {
    return {
      success: false,
      archived: 0,
      kept: 0,
      deleted: 0,
      alreadyCleaned: false,
      error: "Inbox mailbox not found",
    };
  }

  let archived = 0;
  let kept = 0;
  let deleted = 0;

  // Process each email
  for (const email of emails) {
    try {
      // Fetch current state of email
      const fullEmails = await jmap.getEmails([email.id]);

      // Email was deleted by user - skip it
      if (!fullEmails || fullEmails.length === 0) {
        deleted++;
        continue;
      }

      const currentEmail = fullEmails[0];
      const isInInbox = currentEmail.mailboxIds[inbox.id] === true;

      // Remove from all classification/triage folders
      await labelManager.removeAllClassificationLabels(email.id);

      if (isInInbox) {
        // User moved to inbox - just remove from triage folders (already done above)
        kept++;
      } else {
        // Not in inbox - archive the email
        await jmap.archiveEmail(email.id);
        archived++;
      }
    } catch (err) {
      // Email may have been deleted or is inaccessible - count as deleted
      console.error(`Error processing email ${email.id}:`, err);
      deleted++;
    }
  }

  // Mark digest as cleaned
  await store.markDigestCleaned(digest.id);

  return {
    success: true,
    archived,
    kept,
    deleted,
    alreadyCleaned: false,
  };
}
