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
  console.log(`[CLEANUP_DEBUG] Starting cleanup for token=${token.substring(0, 8)}...`);

  // Find the digest by token
  const digest = await store.getDigestByToken(token);

  if (!digest) {
    console.log(`[CLEANUP_DEBUG] Invalid token - no digest found`);
    return {
      success: false,
      archived: 0,
      kept: 0,
      deleted: 0,
      alreadyCleaned: false,
      error: "Invalid or expired token",
    };
  }

  console.log(`[CLEANUP_DEBUG] Found digest_id=${digest.id}, status=${digest.status}, emailCount=${digest.emailCount}`);

  if (digest.status === "cleaned") {
    console.log(`[CLEANUP_DEBUG] Digest already cleaned, skipping`);
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
  console.log(`[CLEANUP_DEBUG] Retrieved ${emails.length} emails from processed_emails table for digest_id=${digest.id}`);

  if (emails.length === 0) {
    console.log(`[CLEANUP_DEBUG] No emails to process, marking digest as cleaned`);
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
    console.log(`[CLEANUP_DEBUG] ERROR: Inbox mailbox not found`);
    return {
      success: false,
      archived: 0,
      kept: 0,
      deleted: 0,
      alreadyCleaned: false,
      error: "Inbox mailbox not found",
    };
  }
  console.log(`[CLEANUP_DEBUG] Inbox mailbox id=${inbox.id}`);

  // Get archive mailbox for safety net (emails with no folders get deleted by Fastmail)
  const archive = await jmap.findMailboxByRole("archive");
  const archiveId = archive?.id;
  console.log(`[CLEANUP_DEBUG] Archive mailbox id=${archiveId || "NOT FOUND"}`);

  // Get classification mailbox IDs to check if email would be orphaned
  const classificationIds = labelManager.getClassificationMailboxIds();
  console.log(`[CLEANUP_DEBUG] Classification mailbox ids=[${classificationIds.join(", ")}]`);

  let archived = 0;
  let kept = 0;
  let deleted = 0;

  // Process each email
  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    console.log(`[CLEANUP_DEBUG] Processing email ${i + 1}/${emails.length}: ${email.id}`);

    try {
      // Fetch current state of email
      const fullEmails = await jmap.getEmails([email.id]);

      // Email was deleted by user - skip it
      if (!fullEmails || fullEmails.length === 0) {
        console.log(`[CLEANUP_DEBUG] Email ${email.id}: NOT FOUND (getEmails returned empty) -> deleted`);
        deleted++;
        continue;
      }

      const currentEmail = fullEmails[0];
      const currentMailboxIds = Object.keys(currentEmail.mailboxIds).filter(
        (k) => currentEmail.mailboxIds[k]
      );
      console.log(`[CLEANUP_DEBUG] Email ${email.id}: found, mailboxIds=[${currentMailboxIds.join(", ")}]`);

      const isInInbox = currentEmail.mailboxIds[inbox.id] === true;
      console.log(`[CLEANUP_DEBUG] Email ${email.id}: isInInbox=${isInInbox}`);

      // Check if email is ONLY in classification folders (would be orphaned after removal)
      const nonClassificationMailboxes = currentMailboxIds.filter(
        (id) => !classificationIds.includes(id)
      );
      console.log(`[CLEANUP_DEBUG] Email ${email.id}: nonClassificationMailboxes=[${nonClassificationMailboxes.join(", ")}]`);

      // Safety: If email would be orphaned (only in classification folders), add to Archive first
      // This prevents Fastmail from deleting emails with no mailboxes
      if (nonClassificationMailboxes.length === 0 && archiveId) {
        console.log(`[CLEANUP_DEBUG] Email ${email.id}: would be orphaned, adding to Archive first`);
        await jmap.addEmailToMailbox(email.id, archiveId);
        console.log(`[CLEANUP_DEBUG] Email ${email.id}: added to Archive`);
      }

      // Remove from all classification/triage folders
      console.log(`[CLEANUP_DEBUG] Email ${email.id}: calling removeAllClassificationLabels`);
      await labelManager.removeAllClassificationLabels(email.id);
      console.log(`[CLEANUP_DEBUG] Email ${email.id}: removeAllClassificationLabels completed`);

      // Track outcome (no archiveEmail call - we just remove labels)
      if (isInInbox) {
        console.log(`[CLEANUP_DEBUG] Email ${email.id}: was in inbox -> kept`);
        kept++;
      } else {
        console.log(`[CLEANUP_DEBUG] Email ${email.id}: not in inbox -> archived (label removed)`);
        archived++;
      }
    } catch (err) {
      // Email may have been deleted or is inaccessible - count as deleted
      console.error(`[CLEANUP_DEBUG] Email ${email.id}: ERROR during processing:`, err);
      deleted++;
    }
  }

  // Mark digest as cleaned
  await store.markDigestCleaned(digest.id);

  console.log(`[CLEANUP_DEBUG] Cleanup complete: archived=${archived}, kept=${kept}, deleted=${deleted}`);

  return {
    success: true,
    archived,
    kept,
    deleted,
    alreadyCleaned: false,
  };
}
