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

  // Batch fetch all emails in one API call
  const emailIds = emails.map((e) => e.id);
  const fullEmails = await jmap.getEmails(emailIds);
  const emailMap = new Map(fullEmails.map((e) => [e.id, e]));

  // Build batch update for all emails
  const classificationRemovalPatch = labelManager.buildRemoveAllClassificationLabelsPatch();
  const updates: Record<string, Record<string, unknown>> = {};

  let archived = 0;
  let kept = 0;
  let deleted = 0;

  for (const email of emails) {
    const currentEmail = emailMap.get(email.id);

    // Email was deleted by user - count as deleted
    if (!currentEmail) {
      deleted++;
      continue;
    }

    const currentMailboxIds = Object.keys(currentEmail.mailboxIds).filter(
      (k) => currentEmail.mailboxIds[k]
    );
    const isInInbox = currentEmail.mailboxIds[inbox.id] === true;

    // Check if email would be orphaned (only in classification folders)
    const nonClassificationMailboxes = currentMailboxIds.filter(
      (id) => !classificationIds.includes(id)
    );

    // Build update patch: remove classification labels + add to archive if orphaned
    const patch: Record<string, unknown> = { ...classificationRemovalPatch };
    if (nonClassificationMailboxes.length === 0 && archiveId) {
      patch[`mailboxIds/${archiveId}`] = true;
    }

    updates[email.id] = patch;

    if (isInInbox) {
      kept++;
    } else {
      archived++;
    }
  }

  // Execute batch update in one API call
  if (Object.keys(updates).length > 0) {
    const result = await jmap.batchUpdateEmails(updates);

    // Adjust counts for emails that failed to update
    for (const failedId of Object.keys(result.notUpdated)) {
      const email = emailMap.get(failedId);
      if (email) {
        const wasInInbox = email.mailboxIds[inbox.id] === true;
        if (wasInInbox) {
          kept--;
        } else {
          archived--;
        }
        deleted++;
      }
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
