import type { JMAPClient } from "../jmap/index.js";
import type { Classification } from "./classifier.js";

// Classification labels as mailboxes (visible in Fastmail UI)
const CLASSIFICATION_LABELS: Record<Classification, string> = {
  important: "Important",
  "needs-reply": "Needs Reply",
  fyi: "FYI",
  "low-priority": "Low Priority",
};

const PARENT_LABEL = "Fastermail";
const CORRECTION_LABEL = "Fastermail-Correction";

export class LabelManager {
  private parentMailboxId: string | null = null;
  private correctionMailboxId: string | null = null;
  private labelMailboxIds: Map<Classification, string> = new Map();
  private initialized = false;

  constructor(private readonly jmap: JMAPClient) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Find or create parent "Fastermail" mailbox
    let parentMailbox = await this.jmap.findMailboxByName(PARENT_LABEL);
    if (!parentMailbox) {
      console.log(`Creating "${PARENT_LABEL}" label folder...`);
      parentMailbox = await this.jmap.createMailbox(PARENT_LABEL);
    }
    this.parentMailboxId = parentMailbox.id;

    // Find or create classification mailboxes
    const mailboxes = await this.jmap.getMailboxes();

    for (const [classification, labelName] of Object.entries(
      CLASSIFICATION_LABELS
    )) {
      const fullName = `${PARENT_LABEL}/${labelName}`;

      // Look for existing mailbox with this parent
      let mailbox = mailboxes.find(
        (m) => m.name === labelName && m.parentId === this.parentMailboxId
      );

      if (!mailbox) {
        console.log(`Creating "${fullName}" label...`);
        mailbox = await this.jmap.createMailbox(labelName, this.parentMailboxId);
      }

      this.labelMailboxIds.set(classification as Classification, mailbox.id);
    }

    // Find or create correction mailbox (for user corrections)
    let correctionMailbox = mailboxes.find((m) => m.name === CORRECTION_LABEL);
    if (!correctionMailbox) {
      console.log(`Creating "${CORRECTION_LABEL}" folder for corrections...`);
      correctionMailbox = await this.jmap.createMailbox(CORRECTION_LABEL);
    }
    this.correctionMailboxId = correctionMailbox.id;

    this.initialized = true;
    console.log("Label folders initialized");
  }

  getCorrectionMailboxId(): string | null {
    return this.correctionMailboxId;
  }

  getClassificationMailboxIds(): string[] {
    return Array.from(this.labelMailboxIds.values());
  }

  async applyClassificationLabel(
    emailId: string,
    classification: Classification
  ): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    // Remove from any existing classification mailboxes first
    await this.removeAllClassificationLabels(emailId);

    // Add to the new classification mailbox
    const mailboxId = this.labelMailboxIds.get(classification);
    if (mailboxId) {
      await this.jmap.addEmailToMailbox(emailId, mailboxId);
    }
  }

  async removeAllClassificationLabels(emailId: string): Promise<void> {
    const entries = Array.from(this.labelMailboxIds.entries());
    console.log(
      `[LABELS_DEBUG] removeAllClassificationLabels(${emailId}): labelMailboxIds has ${entries.length} entries: ${entries.map(([k, v]) => `${k}=${v}`).join(", ")}`
    );

    for (const [classification, mailboxId] of this.labelMailboxIds.entries()) {
      console.log(
        `[LABELS_DEBUG] removeAllClassificationLabels(${emailId}): removing from ${classification} (mailboxId=${mailboxId})`
      );
      try {
        await this.jmap.removeEmailFromMailbox(emailId, mailboxId);
        console.log(
          `[LABELS_DEBUG] removeAllClassificationLabels(${emailId}): removed from ${classification} - SUCCESS`
        );
      } catch (err) {
        // Log the error but continue - email might not be in this mailbox
        console.log(
          `[LABELS_DEBUG] removeAllClassificationLabels(${emailId}): removed from ${classification} - FAILED:`,
          err instanceof Error ? err.message : err
        );
      }
    }
    console.log(`[LABELS_DEBUG] removeAllClassificationLabels(${emailId}): completed`);
  }

  async applyCustomLabel(emailId: string, label: string): Promise<void> {
    // For custom labels, we'll still use keywords (they won't be visible but are searchable)
    const keyword = `$fastermail_${label.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
    await this.jmap.addEmailKeyword(emailId, keyword);
  }

  async flagAsImportant(emailId: string): Promise<void> {
    await this.jmap.addEmailKeyword(emailId, "$flagged");
  }

  async markAsRead(emailId: string): Promise<void> {
    await this.jmap.addEmailKeyword(emailId, "$seen");
  }

  getClassificationFromMailboxIds(
    mailboxIds: Record<string, boolean>
  ): Classification | null {
    for (const [classification, mailboxId] of this.labelMailboxIds.entries()) {
      if (mailboxIds[mailboxId]) {
        return classification;
      }
    }
    return null;
  }

  hasAnyClassificationLabel(keywords: Record<string, boolean>): boolean {
    // This method is called before we know the mailboxIds, so we can't check mailboxes
    // We'll keep this for backwards compatibility but it won't catch existing labels
    // The engine should check mailboxIds separately
    return false;
  }

  hasAnyClassificationMailbox(mailboxIds: Record<string, boolean>): boolean {
    for (const mailboxId of this.labelMailboxIds.values()) {
      if (mailboxIds[mailboxId]) {
        return true;
      }
    }
    return false;
  }
}
