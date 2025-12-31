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

  // Get archive mailbox for safety net (emails with no folders get deleted by Fastmail)
  const archive = await jmap.findMailboxByRole("archive");
  const archiveId = archive?.id;

  // Get classification mailbox IDs to check if email would be orphaned
  const classificationIds = labelManager.getClassificationMailboxIds();

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
      const currentMailboxIds = Object.keys(currentEmail.mailboxIds).filter(
        (k) => currentEmail.mailboxIds[k]
      );

      const isInInbox = currentEmail.mailboxIds[inbox.id] === true;

      // Check if email is ONLY in classification folders (would be orphaned after removal)
      const nonClassificationMailboxes = currentMailboxIds.filter(
        (id) => !classificationIds.includes(id)
      );

      // Safety: If email would be orphaned (only in classification folders), add to Archive first
      // This prevents Fastmail from deleting emails with no mailboxes
      if (nonClassificationMailboxes.length === 0 && archiveId) {
        await jmap.addEmailToMailbox(email.id, archiveId);
      }

      // Remove from all classification/triage folders
      await labelManager.removeAllClassificationLabels(email.id);

      // Track outcome (no archiveEmail call - we just remove labels)
      if (isInInbox) {
        kept++;
      } else {
        archived++;
      }
    } catch {
      // Email may have been deleted or is inaccessible - count as deleted
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
