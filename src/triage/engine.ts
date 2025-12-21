import type { JMAPClient, Email } from "../jmap/index.js";
import type { Store, ProcessedEmail } from "../db/index.js";
import type { ProfileManager } from "../sender/index.js";
import {
  EmailClassifier,
  type Classification,
  type ClassifierConfig,
  type ContentFormat,
} from "./classifier.js";
import { LabelManager } from "./labels.js";
import { buildConfigFromStore } from "./rules.js";
import { CorrectionProcessor } from "./corrections.js";

export interface TriageEngineConfig {
  // Phase 1: Label only (default)
  // Phase 2: Label and archive
  mode: "label-only" | "triage";
  anthropicApiKey: string;
  pollIntervalSeconds: number;
  userEmail: string;
}

export interface TriageResult {
  emailId: string;
  classification: Classification;
  confidence: number;
  reasoning: string;
  labelsApplied: string[];
  actionTaken: "labeled" | "archived" | "kept";
}

export class TriageEngine {
  private readonly classifier: EmailClassifier;
  private readonly labelManager: LabelManager;
  private readonly correctionProcessor: CorrectionProcessor;
  private running = false;
  private pollTimeout: NodeJS.Timeout | null = null;
  private inboxId: string | null = null;
  private archiveId: string | null = null;

  constructor(
    private readonly jmap: JMAPClient,
    private readonly store: Store,
    private readonly profileManager: ProfileManager,
    private readonly config: TriageEngineConfig
  ) {
    this.classifier = new EmailClassifier(config.anthropicApiKey);
    this.labelManager = new LabelManager(jmap);
    this.correctionProcessor = new CorrectionProcessor(
      jmap,
      store,
      this.labelManager,
      config.anthropicApiKey
    );
  }

  async initialize(): Promise<void> {
    // Initialize label manager (creates mailbox folders)
    await this.labelManager.initialize();

    // Initialize correction processor
    await this.correctionProcessor.initialize();

    // Find inbox and archive mailboxes
    const inbox = await this.jmap.findMailboxByRole("inbox");
    if (!inbox) {
      throw new Error("Inbox mailbox not found");
    }
    this.inboxId = inbox.id;

    const archive = await this.jmap.findMailboxByRole("archive");
    if (!archive) {
      throw new Error("Archive mailbox not found");
    }
    this.archiveId = archive.id;

    console.log(`Triage engine initialized (mode: ${this.config.mode})`);
  }

  async start(): Promise<void> {
    if (this.running) {
      console.log("Triage engine already running");
      return;
    }

    this.running = true;
    console.log("Triage engine started");

    // Run immediately, then schedule
    await this.poll();
    this.scheduleNextPoll();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
    console.log("Triage engine stopped");
  }

  private scheduleNextPoll(): void {
    if (!this.running) return;

    this.pollTimeout = setTimeout(async () => {
      await this.poll();
      this.scheduleNextPoll();
    }, this.config.pollIntervalSeconds * 1000);
  }

  async poll(): Promise<TriageResult[]> {
    try {
      // Process any pending corrections first (so new emails benefit from learned patterns)
      const correctionsProcessed = await this.correctionProcessor.processAllCorrections();
      if (correctionsProcessed > 0) {
        console.log(`Applied ${correctionsProcessed} user corrections`);
      }

      // Then process new emails
      return await this.processNewEmails();
    } catch (error) {
      console.error("Poll error:", error);
      return [];
    }
  }

  async processNewEmails(): Promise<TriageResult[]> {
    if (!this.inboxId) {
      throw new Error("Engine not initialized");
    }

    // Get all emails from inbox (up to 500)
    const emailIds = await this.jmap.queryEmails(
      { inMailbox: this.inboxId },
      { limit: 500, sort: [{ property: "receivedAt", isAscending: false }] }
    );

    // Filter to only unprocessed emails
    const unprocessedIds: string[] = [];
    for (const id of emailIds) {
      const isProcessed = await this.store.isEmailProcessed(id);
      if (!isProcessed) {
        unprocessedIds.push(id);
      }
    }

    if (unprocessedIds.length === 0) {
      return [];
    }

    // Process in batches of 50 to avoid API rate limits
    const batchSize = 50;
    const idsToProcess = unprocessedIds.slice(0, batchSize);

    console.log(`Processing ${idsToProcess.length} new emails (${unprocessedIds.length} total unprocessed)...`);

    // Fetch full email data
    const emails = await this.jmap.getEmails(idsToProcess);

    // Filter out emails from self (e.g., digest emails) and those already labeled
    const emailsToProcess = emails.filter((email) => {
      const fromEmail = email.from?.[0]?.email?.toLowerCase();
      const isFromSelf = fromEmail === this.config.userEmail.toLowerCase();
      const alreadyLabeled = this.labelManager.hasAnyClassificationMailbox(email.mailboxIds);
      return !isFromSelf && !alreadyLabeled;
    });

    if (emailsToProcess.length === 0) {
      // Mark as processed even if we skipped them
      for (const email of emails) {
        await this.markAsProcessed(email, "fyi", 1, "Already labeled", "labeled");
      }
      return [];
    }

    // Get classifier config
    const classifierConfig = await buildConfigFromStore(this.store);

    // Process each email
    const results: TriageResult[] = [];

    for (const email of emailsToProcess) {
      try {
        const result = await this.processEmail(email, classifierConfig);
        results.push(result);
      } catch (error) {
        console.error(`Failed to process email ${email.id}:`, error);
      }
    }

    console.log(`Processed ${results.length} emails`);
    return results;
  }

  private async processEmail(
    email: Email,
    config: ClassifierConfig
  ): Promise<TriageResult> {
    const fromEmail = email.from?.[0]?.email;

    // Get sender profile
    let senderProfile = null;
    if (fromEmail) {
      senderProfile = await this.profileManager.getProfile(fromEmail);

      // Record incoming email
      await this.profileManager.recordIncomingEmail(fromEmail);
    }

    // Classify
    const classification = await this.classifier.classify(
      email,
      senderProfile,
      config
    );

    // Apply labels
    const labelsApplied: string[] = [classification.classification];
    await this.labelManager.applyClassificationLabel(
      email.id,
      classification.classification
    );

    // Remove from inbox (keep only in triage folder)
    if (this.inboxId) {
      await this.jmap.removeEmailFromMailbox(email.id, this.inboxId);
    }

    // Apply suggested labels
    for (const label of classification.suggestedLabels.slice(0, 3)) {
      await this.labelManager.applyCustomLabel(email.id, label);
      labelsApplied.push(label);
    }

    // Flag important emails
    if (classification.classification === "important") {
      await this.labelManager.flagAsImportant(email.id);
    }

    // Determine action
    let actionTaken: "labeled" | "archived" | "kept" = "labeled";

    if (this.config.mode === "triage") {
      // In triage mode, archive low-priority emails
      if (classification.classification === "low-priority" && this.archiveId) {
        await this.jmap.archiveEmail(email.id);
        actionTaken = "archived";
      } else {
        actionTaken = "kept";
      }
    }

    // Save to database
    await this.markAsProcessed(
      email,
      classification.classification,
      classification.confidence,
      classification.reasoning,
      actionTaken,
      labelsApplied.join(","),
      classification.contentFormat
    );

    // Log
    const subject = email.subject?.slice(0, 50) || "(no subject)";
    console.log(
      `  [${classification.classification}] ${subject} (${Math.round(classification.confidence * 100)}%)`
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

  private async markAsProcessed(
    email: Email,
    classification: Classification,
    confidence: number,
    reasoning: string,
    actionTaken: string,
    labelsApplied?: string,
    contentFormat: ContentFormat = "standard"
  ): Promise<void> {
    // Get the current pending digest to associate this email with
    const pendingDigest = await this.store.getPendingDigest();

    const processed: ProcessedEmail = {
      id: email.id,
      threadId: email.threadId,
      fromEmail: email.from?.[0]?.email || "unknown",
      fromName: email.from?.[0]?.name || null,
      subject: email.subject,
      receivedAt: email.receivedAt,
      processedAt: new Date().toISOString(),
      classification,
      confidence,
      reasoning,
      labelsApplied: labelsApplied || null,
      actionTaken,
      contentFormat,
      digestId: pendingDigest.id,
    };

    await this.store.saveProcessedEmail(processed);
  }

  // Manual triage for testing
  async triageEmail(emailId: string): Promise<TriageResult> {
    const emails = await this.jmap.getEmails([emailId]);
    if (emails.length === 0) {
      throw new Error(`Email not found: ${emailId}`);
    }

    const config = await buildConfigFromStore(this.store);
    return this.processEmail(emails[0], config);
  }

  async getStats(): Promise<{
    total: number;
    byClassification: Record<string, number>;
    last24h: number;
  }> {
    return this.store.getEmailStats();
  }
}
