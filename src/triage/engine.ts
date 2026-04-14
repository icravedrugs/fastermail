import Anthropic from "@anthropic-ai/sdk";
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
import { ProfileLoader, extractAndClassifyItems, extractViewInBrowserUrl, resolveRedirectUrl } from "../newsletter/index.js";
import { ReadwiseClient } from "../readwise/index.js";
import { saveItemsToReadwise, retryFailedSaves } from "../newsletter/sync.js";
import { pollReadingProgress } from "../newsletter/feedback.js";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Senders whose emails look like link roundups but should stay in the inbox
 * as regular emails (not extracted for links or trashed).
 */
const NEWSLETTER_BYPASS_SENDERS = [
  "@moneysavingexpert.com",
  "@luma-mail.com",
];

/**
 * Subject-line cues that mark an email as a promotional CTA (course signups,
 * deadline reminders, sales) rather than substantive writing. These should
 * never be forwarded to a reader app, even when the topic is relevant.
 */
const PROMO_SUBJECT_PATTERNS = [
  /\b\d+\s*%\s*off\b/i,
  /\bleft to register\b/i,
  /\blast chance\b/i,
  /\b\d+\s*hours?\s*left\b/i,
  /\b\d+\s*days?\s*left\b/i,
  /\bends (tonight|today|soon)\b/i,
  /\bregister now\b/i,
  /\bsale ends\b/i,
  /\bearly bird\b/i,
  /\bfinal call\b/i,
  /\bdon['’]t miss\b/i,
];

function isPromoSubject(subject: string | null | undefined): boolean {
  if (!subject) return false;
  return PROMO_SUBJECT_PATTERNS.some((p) => p.test(subject));
}

export interface TriageEngineConfig {
  // Phase 1: Label only (default)
  // Phase 2: Label and archive
  mode: "label-only" | "triage";
  anthropicApiKey: string;
  pollIntervalSeconds: number;
  userEmail: string;
  readwiseToken?: string;
  readerProfilePath?: string;
  readwiseForwardEmail?: string; // For forwarding essay newsletters to Readwise
  newsletterConfidenceGate?: number; // default 0.7
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
  private readonly anthropicClient: Anthropic;
  private readonly readwise: ReadwiseClient | null;
  private readonly profileLoader: ProfileLoader | null;
  private readonly readwiseForwardEmail: string | null;
  private readonly newsletterConfidenceGate: number;
  private running = false;
  private pollTimeout: NodeJS.Timeout | null = null;
  private pollCount = 0;
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
    this.anthropicClient = new Anthropic({ apiKey: config.anthropicApiKey });
    this.readwise = config.readwiseToken ? new ReadwiseClient(config.readwiseToken) : null;
    this.profileLoader = config.readerProfilePath ? new ProfileLoader(config.readerProfilePath) : null;
    this.readwiseForwardEmail = config.readwiseForwardEmail ?? null;
    this.newsletterConfidenceGate = config.newsletterConfidenceGate ?? 0.7;
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

      // Retry any failed Readwise saves
      if (this.readwise) {
        try {
          const retryResult = await retryFailedSaves(this.readwise, this.store);
          if (retryResult.saved > 0 || retryResult.abandoned > 0) {
            console.log(`Readwise retry: ${retryResult.saved} saved, ${retryResult.failed} still failing, ${retryResult.abandoned} abandoned`);
          }
        } catch (error) {
          console.error("Readwise retry error:", error);
        }
      }

      // Poll Readwise reading progress every ~10 poll cycles (~10 minutes)
      this.pollCount++;
      if (this.config.readwiseToken && this.pollCount % 10 === 0) {
        try {
          const progressResult = await pollReadingProgress(this.store, this.config.readwiseToken);
          if (progressResult.signals > 0) {
            console.log(`Reading progress: checked ${progressResult.checked}, ${progressResult.signals} new signals`);
          }
        } catch (error) {
          console.error("Reading progress poll error:", error);
        }
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
        await this.markAsProcessed(email, "fyi", 1, "Already labeled", "", "labeled");
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

    // Newsletter pipeline: extract items, save to Readwise, trash
    // Two detection paths:
    // 1. LLM explicitly flagged it as newsletter with high confidence
    // 2. Content format is article/link_collection AND classification is low-priority/fyi
    //    (catches newsletters from custom domains like stratechery.com that the LLM misses)
    const isNewsletterBypassed = NEWSLETTER_BYPASS_SENDERS.some((domain) =>
      fromEmail?.toLowerCase().endsWith(domain)
    );
    const isLikelyNewsletter =
      !isNewsletterBypassed &&
      ((classification.isNewsletter && classification.newsletterConfidence >= this.newsletterConfidenceGate) ||
       ((classification.contentFormat === "article" || classification.contentFormat === "link_collection") &&
        (classification.classification === "low-priority" || classification.classification === "fyi")));

    if (
      isLikelyNewsletter &&
      this.readwise &&
      this.profileLoader
    ) {
      try {
        const result = await this.processNewsletterEmail(email, classification, config);
        if (result) return result;
        // null = not reader-worthy, fall through to regular processing
      } catch (error) {
        console.error(`Newsletter processing failed for ${email.id}, falling back to operational:`, error);
        // Fall through to regular processing
      }
    }

    // Apply labels
    const labelsApplied: string[] = [classification.classification];
    await this.labelManager.applyClassificationLabel(
      email.id,
      classification.classification
    );

    // Remove from inbox only for low-priority and fyi emails
    // Important and needs-reply emails stay in inbox for visibility
    if (this.inboxId &&
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
      classification.contentSummary,
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

  private async processNewsletterEmail(
    email: Email,
    classification: { classification: Classification; confidence: number; reasoning: string; contentSummary: string; suggestedLabels: string[]; contentFormat: ContentFormat; isNewsletter: boolean; newsletterConfidence: number },
    config: ClassifierConfig
  ): Promise<TriageResult | null> {
    const fromEmail = email.from?.[0]?.email || "unknown";

    // Deterministic bail-out: promotional subject lines (course signups,
    // deadline/discount urgency) are never reader-worthy regardless of topic.
    // Let these fall through to regular email processing.
    if (isPromoSubject(email.subject)) {
      console.log(`  [newsletter:promo-subject] ${email.subject?.slice(0, 60)} — processing as regular email`);
      return null;
    }

    // Eagerly fetch full email body for newsletter extraction
    const emailBody = await this.jmap.getEmailBody(email.id);

    // Load reader profile
    const profile = await this.profileLoader!.load();

    // Get recent tier corrections for few-shot learning
    const corrections = await this.store.getRecentTierCorrections(20);

    // Decide essay vs link-collection BEFORE extraction.
    // Articles contain reference links but the value is the essay itself — forward it whole.
    // Only link_collection format should go through link extraction.
    const isEssay = classification.contentFormat !== "link_collection";

    if (isEssay) {
      // Classify the essay's relevance without extracting links
      const items = await extractAndClassifyItems(emailBody, profile, corrections, this.anthropicClient);
      const essayTier = items.length >= 1 ? items[0].tier : "nice-to-have";
      const essayTopic = items.length >= 1 ? items[0].topic : "general";
      const essayConfidence = items.length >= 1 ? items[0].confidence : 0.5;
      const essayReason = items.length >= 1 ? items[0].reason : "Essay newsletter";
      const readerWorthy = items.length >= 1 ? items[0].readerWorthy : true;

      // Not reader-worthy (account updates, fund reports, etc.) — bail out and
      // let the caller process this as a normal email instead
      if (!readerWorthy) {
        console.log(`  [newsletter:not-reader-worthy] ${email.subject?.slice(0, 50)} — processing as regular email`);
        return null;
      }

      // Build the best URL: resolve "view in browser" link, fall back to sender domain
      const html = getEmailBodyHtml(emailBody);
      const rawViewUrl = html ? extractViewInBrowserUrl(html) : null;
      let essayUrl: string;
      if (rawViewUrl) {
        essayUrl = await resolveRedirectUrl(rawViewUrl);
      } else {
        // Use sender domain so Readwise shows a meaningful origin
        const senderDomain = fromEmail.split("@")[1] || "newsletter";
        essayUrl = `https://${senderDomain}/fastermail/${email.id}`;
      }

      // Build author: LLM-extracted author, with newsletter name as fallback
      const newsletterName = email.from?.[0]?.name || null;
      const essayAuthor = items.length >= 1 && items[0].author
        ? (newsletterName && items[0].author !== newsletterName
            ? `${items[0].author}, ${newsletterName}`
            : items[0].author)
        : newsletterName;

      // Store as single item in DB (for stats and correction UI)
      const itemId = await this.store.saveNewsletterItem({
        emailId: email.id,
        url: essayUrl,
        title: email.subject || "(no subject)",
        description: classification.contentSummary || "",
        tier: essayTier as any,
        topicTag: essayTopic,
        confidence: essayConfidence,
        reason: essayReason,
        readwiseStatus: essayTier !== "skip" ? "pending" : null,
        readwiseDocId: null,
        retryCount: 0,
        nextRetryAfter: null,
      });

      // Save to Readwise via API (replaces SMTP forwarding — preserves metadata)
      if (essayTier !== "skip" && this.readwise) {
        const tags = [
          "tier:" + essayTier,
          "src:" + slugify(newsletterName || fromEmail),
          "topic:" + essayTopic,
        ];
        try {
          const response = await this.readwise.save({
            url: essayUrl,
            html: html || undefined,
            should_clean_html: true,
            title: email.subject || "(no subject)",
            author: essayAuthor || undefined,
            summary: classification.contentSummary || undefined,
            published_date: email.receivedAt?.split("T")[0],
            category: "email",
            tags,
            notes: essayReason,
            location: essayTier === "must-read" ? "new" : "later",
            saved_using: "fastermail",
          });
          await this.store.updateNewsletterItemReadwise(itemId, "saved", response.id, 0, null);
          console.log(`  [newsletter:essay] Saved to Readwise via API: ${email.subject?.slice(0, 50)}`);
        } catch (error) {
          console.error(`Failed to save essay to Readwise:`, error);
          const nextRetryAfter = new Date(Date.now() + 60_000).toISOString();
          await this.store.updateNewsletterItemReadwise(itemId, "failed", null, 1, nextRetryAfter);
        }
      }

      console.log(`  [newsletter:essay] ${email.subject?.slice(0, 50)} → ${essayTier}`);
    } else {
      // Link-collection: extract and classify individual links
      const items = await extractAndClassifyItems(emailBody, profile, corrections, this.anthropicClient);
      const saveResult = await saveItemsToReadwise(
        items,
        email.id,
        email.from?.[0]?.name || fromEmail,
        this.readwise!,
        this.store
      );

      console.log(`  [newsletter] ${email.subject?.slice(0, 50)} → ${items.length} items (${saveResult.saved} saved, ${saveResult.skipped} skipped)`);
    }

    // Delete the newsletter (trash it — user can recover from trash if needed)
    try {
      const trash = await this.jmap.findMailboxByRole("trash");
      if (trash) {
        await this.jmap.moveEmail(email.id, trash.id);
      }
    } catch (error) {
      console.error(`Failed to trash newsletter ${email.id}:`, error);
    }

    // Save to processed_emails with is_newsletter = true
    const pendingDigest = await this.store.getPendingDigest();
    const processed: ProcessedEmail = {
      id: email.id,
      threadId: email.threadId,
      fromEmail,
      fromName: email.from?.[0]?.name || null,
      subject: email.subject,
      receivedAt: email.receivedAt,
      processedAt: new Date().toISOString(),
      classification: classification.classification,
      confidence: classification.confidence,
      reasoning: classification.reasoning,
      contentSummary: classification.contentSummary,
      labelsApplied: classification.suggestedLabels.join(","),
      actionTaken: "deleted",
      contentFormat: classification.contentFormat,
      digestId: pendingDigest.id,
      isNewsletter: true,
    };
    await this.store.saveProcessedEmail(processed);

    return {
      emailId: email.id,
      classification: classification.classification,
      confidence: classification.confidence,
      reasoning: classification.reasoning,
      labelsApplied: classification.suggestedLabels,
      actionTaken: "archived",
    };
  }

  private async markAsProcessed(
    email: Email,
    classification: Classification,
    confidence: number,
    reasoning: string,
    contentSummary: string,
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
      contentSummary,
      labelsApplied: labelsApplied || null,
      actionTaken,
      contentFormat,
      digestId: pendingDigest.id,
      isNewsletter: false,
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

// Helper functions for email body extraction (used by processNewsletterEmail for forwarding)
function getEmailBodyText(email: Email): string {
  if (!email.bodyValues) return email.preview || "";
  if (email.textBody) {
    for (const part of email.textBody) {
      if (part.partId && email.bodyValues[part.partId]) {
        return email.bodyValues[part.partId].value;
      }
    }
  }
  if (email.htmlBody) {
    for (const part of email.htmlBody) {
      if (part.partId && email.bodyValues[part.partId]) {
        return email.bodyValues[part.partId].value
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/\s+/g, " ")
          .trim();
      }
    }
  }
  return email.preview || "";
}

function getEmailBodyHtml(email: Email): string | null {
  if (!email.bodyValues || !email.htmlBody) return null;
  for (const part of email.htmlBody) {
    if (part.partId && email.bodyValues[part.partId]) {
      return email.bodyValues[part.partId].value;
    }
  }
  return null;
}
