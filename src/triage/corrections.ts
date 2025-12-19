import Anthropic from "@anthropic-ai/sdk";
import type { JMAPClient, Email } from "../jmap/index.js";
import type { Store, Correction } from "../db/index.js";
import type { Classification } from "./classifier.js";
import type { LabelManager } from "./labels.js";

export interface ParsedCorrection {
  newClassification: Classification;
  reasoning: string;
}

export interface PendingCorrection {
  emailId: string;
  email: Email;
  correctionText: string;
  originalClassification: string;
}

export class CorrectionProcessor {
  private readonly client: Anthropic;
  private correctionMailboxId: string | null = null;

  constructor(
    private readonly jmap: JMAPClient,
    private readonly store: Store,
    private readonly labelManager: LabelManager,
    apiKey: string
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async initialize(): Promise<void> {
    // Get the correction mailbox ID from LabelManager
    this.correctionMailboxId = this.labelManager.getCorrectionMailboxId();
  }

  /**
   * Parse free-text correction using Claude
   */
  async parseCorrection(text: string): Promise<ParsedCorrection> {
    const response = await this.client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: `Parse this email classification correction into a structured format.

The user wrote: "${text}"

Extract:
1. The new classification (must be one of: important, needs-reply, fyi, low-priority)
2. The reasoning for the correction

Respond in this exact format:
CLASSIFICATION: [one of: important, needs-reply, fyi, low-priority]
REASONING: [the user's explanation, cleaned up into a reusable rule]`,
        },
      ],
    });

    const responseText =
      response.content[0].type === "text" ? response.content[0].text : "";

    // Parse the response
    let classification: Classification = "fyi";
    let reasoning = text;

    const lines = responseText.split("\n");
    for (const line of lines) {
      if (line.startsWith("CLASSIFICATION:")) {
        const value = line.replace("CLASSIFICATION:", "").trim().toLowerCase();
        if (
          value === "important" ||
          value === "needs-reply" ||
          value === "fyi" ||
          value === "low-priority"
        ) {
          classification = value;
        }
      } else if (line.startsWith("REASONING:")) {
        reasoning = line.replace("REASONING:", "").trim();
      }
    }

    return { newClassification: classification, reasoning };
  }

  /**
   * Find emails that have been placed in the Fastermail-Correction folder
   * with sublabels containing the correction text
   */
  async scanForCorrections(): Promise<PendingCorrection[]> {
    if (!this.correctionMailboxId) {
      console.log("  [corrections] No correction mailbox ID");
      return [];
    }

    // Get all emails in the correction mailbox OR any of its children
    const mailboxes = await this.jmap.getMailboxes();
    const correctionMailboxIds = [this.correctionMailboxId];

    // Also include child mailboxes (the actual correction labels)
    for (const mailbox of mailboxes) {
      if (mailbox.parentId === this.correctionMailboxId) {
        correctionMailboxIds.push(mailbox.id);
      }
    }

    // Query emails in any correction-related mailbox
    let allEmailIds: string[] = [];
    for (const mailboxId of correctionMailboxIds) {
      const emailIds = await this.jmap.queryEmails(
        { inMailbox: mailboxId },
        { limit: 50 }
      );
      allEmailIds = [...allEmailIds, ...emailIds];
    }

    // Deduplicate
    const emailIds = [...new Set(allEmailIds)];

    if (emailIds.length > 0) {
      console.log(`  [corrections] Found ${emailIds.length} emails in correction folders`);
    }

    if (emailIds.length === 0) {
      return [];
    }

    const emails = await this.jmap.getEmails(emailIds);
    const corrections: PendingCorrection[] = [];

    for (const email of emails) {
      // Look for correction sublabels in the email's mailboxIds
      // The correction text is in nested mailbox names under Fastermail-Correction
      const correctionText = this.findCorrectionText(email, mailboxes);

      if (correctionText) {
        // Get original classification from processed_emails table
        const processed = await this.store.getProcessedEmail(email.id);
        const originalClassification = processed?.classification || "unknown";

        console.log(`  [corrections] Found correction: "${correctionText}" for "${email.subject}"`);

        corrections.push({
          emailId: email.id,
          email,
          correctionText,
          originalClassification,
        });
      }
    }

    return corrections;
  }

  /**
   * Find the correction text from the email's mailbox membership
   */
  private findCorrectionText(
    email: Email,
    mailboxes: Array<{ id: string; name: string; parentId: string | null }>
  ): string | null {
    // Look for mailboxes that are children of the correction folder
    for (const [mailboxId, isIn] of Object.entries(email.mailboxIds)) {
      if (!isIn) continue;

      const mailbox = mailboxes.find((m) => m.id === mailboxId);
      if (mailbox && mailbox.parentId === this.correctionMailboxId) {
        // The mailbox name IS the correction text
        return mailbox.name;
      }
    }

    return null;
  }

  /**
   * Process a single correction: parse, apply, store, cleanup
   */
  async processCorrection(pending: PendingCorrection): Promise<void> {
    console.log(`Processing correction for: ${pending.email.subject}`);

    // Parse the correction text
    const parsed = await this.parseCorrection(pending.correctionText);

    console.log(
      `  Parsed: ${pending.originalClassification} → ${parsed.newClassification}`
    );
    console.log(`  Reason: ${parsed.reasoning}`);

    // Store the correction for future learning
    const correction: Correction = {
      emailId: pending.emailId,
      originalClassification: pending.originalClassification,
      correctedClassification: parsed.newClassification,
      reasoning: parsed.reasoning,
      emailSubject: pending.email.subject || null,
      emailFrom: pending.email.from?.[0]?.email || null,
      emailPreview: pending.email.preview || null,
    };

    await this.store.saveCorrection(correction);

    // Apply the new classification label
    await this.labelManager.applyClassificationLabel(
      pending.emailId,
      parsed.newClassification
    );

    // Update the processed_emails record
    await this.store.updateEmailClassification(
      pending.emailId,
      parsed.newClassification
    );

    // Remove email from correction mailbox (and its sublabel)
    await this.cleanupCorrectionLabels(pending);

    console.log(`  Correction applied and stored`);
  }

  /**
   * Remove the email from correction-related mailboxes and delete the correction sublabel
   */
  private async cleanupCorrectionLabels(
    pending: PendingCorrection
  ): Promise<void> {
    const mailboxes = await this.jmap.getMailboxes();
    const mailboxesToDelete: string[] = [];

    // Remove from any mailbox that's a child of correction folder
    for (const [mailboxId, isIn] of Object.entries(pending.email.mailboxIds)) {
      if (!isIn) continue;

      const mailbox = mailboxes.find((m) => m.id === mailboxId);
      if (mailbox && mailbox.parentId === this.correctionMailboxId) {
        // This is a correction sublabel - remove email and mark for deletion
        await this.jmap.removeEmailFromMailbox(pending.emailId, mailboxId);
        mailboxesToDelete.push(mailboxId);
      } else if (mailbox && mailbox.id === this.correctionMailboxId) {
        // This is the parent correction folder - just remove email
        await this.jmap.removeEmailFromMailbox(pending.emailId, mailboxId);
      }
    }

    // Delete the empty correction sublabel folders
    for (const mailboxId of mailboxesToDelete) {
      try {
        await this.jmap.deleteMailbox(mailboxId);
        console.log(`  [corrections] Deleted correction folder`);
      } catch (error) {
        // Might fail if folder not empty or other issues - that's ok
        console.log(`  [corrections] Could not delete correction folder (may not be empty)`);
      }
    }
  }

  /**
   * Process all pending corrections
   */
  async processAllCorrections(): Promise<number> {
    const pending = await this.scanForCorrections();

    if (pending.length === 0) {
      return 0;
    }

    console.log(`Found ${pending.length} corrections to process`);

    for (const correction of pending) {
      try {
        await this.processCorrection(correction);
      } catch (error) {
        console.error(
          `Failed to process correction for ${correction.emailId}:`,
          error
        );
      }
    }

    return pending.length;
  }
}
