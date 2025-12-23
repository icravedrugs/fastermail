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
      const mailboxIdsList = Object.keys(currentEmail.mailboxIds).filter(
        (k) => currentEmail.mailboxIds[k]
      );
      console.log(`[CLEANUP_DEBUG] Email ${email.id}: found, mailboxIds=[${mailboxIdsList.join(", ")}]`);

      const isInInbox = currentEmail.mailboxIds[inbox.id] === true;
      console.log(`[CLEANUP_DEBUG] Email ${email.id}: isInInbox=${isInInbox}`);

      // Remove from all classification/triage folders
      console.log(`[CLEANUP_DEBUG] Email ${email.id}: calling removeAllClassificationLabels`);
      await labelManager.removeAllClassificationLabels(email.id);
      console.log(`[CLEANUP_DEBUG] Email ${email.id}: removeAllClassificationLabels completed`);

      if (isInInbox) {
        // User moved to inbox - just remove from triage folders (already done above)
        console.log(`[CLEANUP_DEBUG] Email ${email.id}: in inbox -> kept`);
        kept++;
      } else {
        // Not in inbox - archive the email
        console.log(`[CLEANUP_DEBUG] Email ${email.id}: not in inbox, calling archiveEmail`);
        await jmap.archiveEmail(email.id);
        console.log(`[CLEANUP_DEBUG] Email ${email.id}: archiveEmail completed -> archived`);
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
