import type { JMAPClient, Email } from "../jmap/index.js";
import type { Store, ProcessedEmail } from "../db/index.js";
import type { ProfileManager } from "../sender/index.js";
import {
  EmailClassifier,
  type Classification,
  type ClassificationResult,
  type ClassifierConfig,
  type ContentFormat,
} from "./classifier.js";
import { LabelManager } from "./labels.js";
import { buildConfigFromStore, computeConfigHash } from "./rules.js";
import { detectOtp, PROMOTED_SENDERS, GITHUB_SENDER, OTP_TTL_MS } from "./pretriage.js";
import { CorrectionProcessor } from "./corrections.js";

export interface TriageEngineConfig {
  // Phase 1: Label only (default)
  // Phase 2: Label and archive
  mode: "label-only" | "triage";
  anthropicApiKey: string;
  pollIntervalSeconds: number;
  userEmail: string;
}

// List-Id headers look like `Friendly Name <list.id.domain>`; the part in
// angle brackets is the stable list identity.
function normalizeListId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.match(/<([^>]+)>/);
  const listId = (match ? match[1] : raw).trim();
  return listId || null;
}

export type TriageAction =
  | "labeled"
  | "archived"
  | "kept"
  | "promoted"
  | "otp-bypass";

export interface TriageResult {
  emailId: string;
  classification: Classification;
  confidence: number;
  reasoning: string;
  labelsApplied: string[];
  actionTaken: TriageAction;
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

      await this.expireOtps();

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

    // Partition out emails from self (e.g., digest emails) and those already
    // labeled. Filtered emails are recorded as classification='skipped' —
    // a real classification would be fabricated data, and no row at all would
    // re-fetch them on every poll (isEmailProcessed is the only gate).
    const emailsToProcess: Email[] = [];
    for (const email of emails) {
      const fromEmail = email.from?.[0]?.email?.toLowerCase();
      const isFromSelf = fromEmail === this.config.userEmail.toLowerCase();
      const alreadyLabeled = this.labelManager.hasAnyClassificationMailbox(email.mailboxIds);

      if (isFromSelf || alreadyLabeled) {
        await this.markAsProcessed(email, {
          classification: "skipped",
          confidence: 0,
          reasoning: isFromSelf ? "Skipped: from self" : "Skipped: already labeled",
          contentSummary: "",
          actionTaken: "skipped",
          digestId: null,
        });
      } else {
        emailsToProcess.push(email);
      }
    }

    if (emailsToProcess.length === 0) {
      return [];
    }

    // Get classifier config and fingerprint it: the config mutates whenever a
    // correction lands, and the hash is what lets analysis windows tell which
    // policy classified which rows.
    const classifierConfig = await buildConfigFromStore(this.store);
    const configHash = computeConfigHash(classifierConfig);

    // Process each email
    const results: TriageResult[] = [];

    for (const email of emailsToProcess) {
      try {
        const result = await this.processEmail(email, classifierConfig, configHash);
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
    config: ClassifierConfig,
    configHash: string
  ): Promise<TriageResult> {
    const fromEmail = email.from?.[0]?.email?.toLowerCase();

    // Deterministic pre-triage: one-time codes bypass everything. They stay
    // in the inbox untouched (no label, no flag, no digest) and are trashed
    // by expireOtps() once stale. Must run before sender promotion — some
    // promoted senders also send sign-in codes (see pretriage.ts). GitHub is
    // exempt: PR subjects like "Verify code signing" are never OTPs.
    const otp = fromEmail === GITHUB_SENDER ? null : detectOtp(email);
    if (otp) {
      await this.markAsProcessed(email, {
        classification: "important",
        confidence: 1,
        reasoning: "One-time code (deterministic pre-triage)",
        contentSummary: otp.code ? `OTP code: ${otp.code}` : "One-time code",
        actionTaken: "otp-bypass",
        contentFormat: "transactional",
        digestId: null,
        configHash,
      });

      console.log(`  [otp-bypass] ${email.subject?.slice(0, 50) || "(no subject)"}`);
      return {
        emailId: email.id,
        classification: "important",
        confidence: 1,
        reasoning: "One-time code (deterministic pre-triage)",
        labelsApplied: [],
        actionTaken: "otp-bypass",
      };
    }

    // Get sender profile
    let senderProfile = null;
    if (fromEmail) {
      senderProfile = await this.profileManager.getProfile(fromEmail);

      // Record incoming email
      await this.profileManager.recordIncomingEmail(fromEmail);
    }

    // GitHub PR threads are classified once: later notifications inherit the
    // thread's verdict instead of drawing a fresh (and, per window 1, usually
    // contradictory) one per message. Also saves the classifier call.
    // Inherited rows carry the ORIGIN row's config hash — the verdict was
    // produced by that policy, not the one running this poll.
    let classification: ClassificationResult | null = null;
    let rowConfigHash: string | null = configHash;
    if (fromEmail === GITHUB_SENDER && email.threadId) {
      const inherited = await this.store.getLatestThreadClassification(email.threadId);
      if (inherited) {
        classification = {
          classification: inherited.classification as Classification,
          confidence: inherited.confidence,
          reasoning: "Thread continuation (classification inherited)",
          contentSummary: email.preview ? email.preview.slice(0, 160) : "",
          suggestedLabels: [],
          contentFormat: inherited.contentFormat,
        };
        rowConfigHash = inherited.configHash;
      }
    }

    if (!classification) {
      classification = await this.classifier.classify(email, senderProfile, config);
    }

    // Apply labels
    const labelsApplied: string[] = [classification.classification];
    await this.labelManager.applyClassificationLabel(
      email.id,
      classification.classification
    );

    // Window-1-verified promotion: allowlisted senders keep their emails in
    // the inbox regardless of classification. Routing only — the classifier's
    // verdict is stored untouched, and the email keeps its digest row (marked
    // as already in the inbox) so the rescue/delete signal survives.
    const promoted = fromEmail !== undefined && PROMOTED_SENDERS.has(fromEmail);

    // Remove from inbox only for low-priority and fyi emails
    // Important and needs-reply emails stay in inbox for visibility
    if (this.inboxId &&
        !promoted &&
        classification.classification !== "important" &&
        classification.classification !== "needs-reply") {
      await this.jmap.removeEmailFromMailbox(email.id, this.inboxId);
    }

    // NOTE: Disabled custom keyword labels - Fastmail has a limit of ~100 unique keywords
    // and we were hitting "too many user flags" errors. The suggested labels are still
    // stored in the database (labelsApplied field) for reference.
    // for (const label of classification.suggestedLabels.slice(0, 3)) {
    //   await this.labelManager.applyCustomLabel(email.id, label);
    //   labelsApplied.push(label);
    // }
    labelsApplied.push(...classification.suggestedLabels.slice(0, 3));

    // Flag important emails
    if (classification.classification === "important") {
      await this.labelManager.flagAsImportant(email.id);
    }

    // Determine action
    let actionTaken: TriageAction = promoted ? "promoted" : "labeled";

    if (this.config.mode === "triage" && !promoted) {
      // In triage mode, archive low-priority emails
      if (classification.classification === "low-priority" && this.archiveId) {
        await this.jmap.archiveEmail(email.id);
        actionTaken = "archived";
      } else {
        actionTaken = "kept";
      }
    }

    // Save to database
    await this.markAsProcessed(email, {
      classification: classification.classification,
      confidence: classification.confidence,
      reasoning: classification.reasoning,
      contentSummary: classification.contentSummary,
      actionTaken,
      labelsApplied: labelsApplied.join(","),
      contentFormat: classification.contentFormat,
      configHash: rowConfigHash,
    });

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
    fields: {
      classification: string;
      confidence: number;
      reasoning: string;
      contentSummary: string;
      actionTaken: string;
      labelsApplied?: string;
      contentFormat?: ContentFormat;
      // undefined = attach to the pending digest; null = never digest
      digestId?: number | null;
      configHash?: string | null;
    }
  ): Promise<void> {
    let digestId: number | null;
    if (fields.digestId === undefined) {
      const pendingDigest = await this.store.getPendingDigest();
      digestId = pendingDigest.id;
    } else {
      digestId = fields.digestId;
    }

    const processed: ProcessedEmail = {
      id: email.id,
      threadId: email.threadId,
      fromEmail: email.from?.[0]?.email || "unknown",
      fromName: email.from?.[0]?.name || null,
      subject: email.subject,
      receivedAt: email.receivedAt,
      processedAt: new Date().toISOString(),
      classification: fields.classification,
      confidence: fields.confidence,
      reasoning: fields.reasoning,
      contentSummary: fields.contentSummary,
      labelsApplied: fields.labelsApplied || null,
      actionTaken: fields.actionTaken,
      contentFormat: fields.contentFormat ?? "standard",
      digestId,
      listId: normalizeListId(email["header:List-Id:asText"]),
      baseClassification: null,
      configHash: fields.configHash ?? null,
    };

    await this.store.saveProcessedEmail(processed);
  }

  /**
   * Trash one-time-code emails past their TTL — but only mail the user never
   * touched: anything read, filed, or archived is marked 'otp-kept' and left
   * alone, so an OTP false positive the user cared about is never destroyed.
   * The move is self-attributed via the mutation registry, so the event log
   * records it as fastermail's action, not the user's. action_taken flips to
   * 'otp-expired' only when the move actually happened (or the email is
   * already gone); transient failures leave 'otp-bypass' so the next poll
   * retries instead of silently recording a trash move that never happened.
   */
  private async expireOtps(): Promise<void> {
    const cutoff = new Date(Date.now() - OTP_TTL_MS).toISOString();
    const expired = await this.store.getExpiredOtpEmails(cutoff);
    if (expired.length === 0) return;

    const trash = await this.jmap.findMailboxByRole("trash");
    if (!trash) {
      console.error("OTP expiry: trash mailbox not found; leaving OTPs for retry");
      return;
    }

    for (const email of expired) {
      let current;
      try {
        const fetched = await this.jmap.getEmails([email.id], ["id", "keywords", "mailboxIds"]);
        current = fetched[0];
      } catch (error) {
        console.error(`OTP expiry: could not fetch ${email.id}, will retry:`, error);
        continue;
      }

      if (!current) {
        // Already deleted (by the user or another client)
        await this.store.setActionTaken(email.id, "otp-expired");
        continue;
      }

      const wasRead = Boolean(current.keywords["$seen"]);
      const stillInInbox = this.inboxId ? current.mailboxIds[this.inboxId] === true : false;
      if (wasRead || !stillInInbox) {
        await this.store.setActionTaken(email.id, "otp-kept");
        console.log(`  [otp-kept] ${email.subject?.slice(0, 50) || email.id} (user touched it)`);
        continue;
      }

      try {
        await this.jmap.moveEmail(email.id, trash.id);
      } catch (error) {
        console.error(`OTP expiry: move failed for ${email.id}, will retry:`, error);
        continue;
      }
      await this.store.setActionTaken(email.id, "otp-expired");
      console.log(`  [otp-expired] ${email.subject?.slice(0, 50) || email.id}`);
    }
  }

  async getStats(): Promise<{
    total: number;
    byClassification: Record<string, number>;
    last24h: number;
  }> {
    return this.store.getEmailStats();
  }
}
