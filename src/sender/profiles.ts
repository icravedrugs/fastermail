import type { Store, SenderProfile as DBSenderProfile } from "../db/index.js";
import type { JMAPClient } from "../jmap/index.js";
import {
  analyzeEmail,
  aggregateAnalyses,
  inferRelationshipType,
} from "./analyzer.js";
import type { SenderProfile, AnalysisSample, EmailAnalysis } from "./types.js";

export class ProfileManager {
  constructor(
    private readonly store: Store,
    private readonly jmap: JMAPClient,
    private readonly userEmail: string
  ) {}

  async getOrCreateProfile(email: string): Promise<SenderProfile> {
    const existing = await this.store.getSenderProfile(email);
    if (existing) {
      return this.dbToProfile(existing);
    }

    // Create new profile with defaults
    const domain = email.split("@")[1] || "unknown";
    const now = new Date().toISOString();

    const newProfile: DBSenderProfile = {
      email,
      domain,
      relationshipType: "unknown",
      formality: 0.5,
      avgResponseLength: 0,
      greetingPatterns: [],
      signoffPatterns: [],
      usesEmoji: false,
      usesExclamations: false,
      emailsReceived: 0,
      emailsSent: 0,
      avgResponseTimeHours: null,
      lastInteraction: null,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.saveSenderProfile(newProfile);
    return this.dbToProfile(newProfile);
  }

  async analyzeHistoricalEmails(
    limit: number = 500
  ): Promise<{ profilesUpdated: number; emailsAnalyzed: number }> {
    console.log("Analyzing sent emails to build sender profiles...");

    // Find sent mailbox
    const sentMailbox = await this.jmap.findMailboxByRole("sent");
    if (!sentMailbox) {
      console.log("Sent mailbox not found, skipping historical analysis");
      return { profilesUpdated: 0, emailsAnalyzed: 0 };
    }

    // Query sent emails
    const emailIds = await this.jmap.queryEmails(
      { inMailbox: sentMailbox.id },
      { limit, sort: [{ property: "sentAt", isAscending: false }] }
    );

    if (emailIds.length === 0) {
      console.log("No sent emails found");
      return { profilesUpdated: 0, emailsAnalyzed: 0 };
    }

    // Fetch email details with body
    const emails = await this.jmap.getEmails(emailIds, [
      "id",
      "from",
      "to",
      "cc",
      "subject",
      "sentAt",
      "inReplyTo",
      "preview",
      "bodyValues",
      "textBody",
    ]);

    // Group by recipient
    const recipientEmails = new Map<string, AnalysisSample[]>();

    for (const email of emails) {
      const recipients = [
        ...(email.to || []),
        ...(email.cc || []),
      ];

      // Get body text
      let body = email.preview || "";
      if (email.bodyValues && email.textBody?.[0]?.partId) {
        body = email.bodyValues[email.textBody[0].partId]?.value || body;
      }

      for (const recipient of recipients) {
        if (recipient.email === this.userEmail) continue;

        const sample: AnalysisSample = {
          to: recipient.email,
          from: this.userEmail,
          subject: email.subject,
          body,
          sentAt: email.sentAt || email.receivedAt,
          inReplyTo: email.inReplyTo?.[0] || null,
        };

        if (!recipientEmails.has(recipient.email)) {
          recipientEmails.set(recipient.email, []);
        }
        recipientEmails.get(recipient.email)!.push(sample);
      }
    }

    // Analyze each recipient
    let profilesUpdated = 0;

    for (const [email, samples] of recipientEmails) {
      const analyses: EmailAnalysis[] = samples.map(analyzeEmail);
      const aggregated = aggregateAnalyses(analyses);

      const domain = email.split("@")[1] || "unknown";
      const existingProfile = await this.store.getSenderProfile(email);
      const emailsReceived = existingProfile?.emailsReceived || 0;

      const relationshipType = inferRelationshipType(
        domain,
        aggregated.avgFormality,
        emailsReceived,
        samples.length
      );

      const now = new Date().toISOString();
      const profile: DBSenderProfile = {
        email,
        domain,
        relationshipType,
        formality: aggregated.avgFormality,
        avgResponseLength: Math.round(aggregated.avgWordCount),
        greetingPatterns: aggregated.greetingPatterns,
        signoffPatterns: aggregated.signoffPatterns,
        usesEmoji: aggregated.usesEmoji,
        usesExclamations: aggregated.usesExclamations,
        emailsReceived,
        emailsSent: samples.length,
        avgResponseTimeHours: null, // TODO: Calculate from thread analysis
        lastInteraction: samples[0]?.sentAt || null,
        createdAt: existingProfile?.createdAt || now,
        updatedAt: now,
      };

      await this.store.saveSenderProfile(profile);
      profilesUpdated++;
    }

    console.log(
      `Analyzed ${emails.length} sent emails, updated ${profilesUpdated} profiles`
    );

    return { profilesUpdated, emailsAnalyzed: emails.length };
  }

  async recordIncomingEmail(fromEmail: string): Promise<void> {
    const existing = await this.store.getSenderProfile(fromEmail);

    if (existing) {
      await this.store.incrementSenderReceived(fromEmail);
    } else {
      // Create minimal profile
      const domain = fromEmail.split("@")[1] || "unknown";
      const now = new Date().toISOString();

      const newProfile: DBSenderProfile = {
        email: fromEmail,
        domain,
        relationshipType: "unknown",
        formality: 0.5,
        avgResponseLength: 0,
        greetingPatterns: [],
        signoffPatterns: [],
        usesEmoji: false,
        usesExclamations: false,
        emailsReceived: 1,
        emailsSent: 0,
        avgResponseTimeHours: null,
        lastInteraction: now,
        createdAt: now,
        updatedAt: now,
      };

      await this.store.saveSenderProfile(newProfile);
    }
  }

  async getProfile(email: string): Promise<SenderProfile | null> {
    const dbProfile = await this.store.getSenderProfile(email);
    if (!dbProfile) return null;
    return this.dbToProfile(dbProfile);
  }

  async getAllProfiles(): Promise<SenderProfile[]> {
    const profiles = await this.store.getAllSenderProfiles();
    return profiles.map(this.dbToProfile);
  }

  private dbToProfile(db: DBSenderProfile): SenderProfile {
    return {
      email: db.email,
      domain: db.domain,
      relationshipType: db.relationshipType,
      style: {
        formality: db.formality,
        avgResponseLength: db.avgResponseLength,
        greetingPatterns: db.greetingPatterns,
        signoffPatterns: db.signoffPatterns,
        usesEmoji: db.usesEmoji,
        usesExclamations: db.usesExclamations,
      },
      stats: {
        emailsReceived: db.emailsReceived,
        emailsSent: db.emailsSent,
        avgResponseTimeHours: db.avgResponseTimeHours,
        lastInteraction: db.lastInteraction,
      },
    };
  }

  formatProfileForClassifier(profile: SenderProfile): string {
    const parts: string[] = [];

    // Relationship
    parts.push(`Relationship: ${profile.relationshipType}`);

    // Interaction stats
    parts.push(
      `History: ${profile.stats.emailsReceived} received, ${profile.stats.emailsSent} sent`
    );

    // Communication style
    const formality = profile.style.formality;
    const formalityDesc =
      formality > 0.7
        ? "formal"
        : formality > 0.4
          ? "professional"
          : "casual";
    parts.push(`Your tone with them: ${formalityDesc}`);

    if (profile.style.greetingPatterns.length > 0) {
      parts.push(`Typical greeting: "${profile.style.greetingPatterns[0]}"`);
    }

    if (profile.style.signoffPatterns.length > 0) {
      parts.push(`Typical sign-off: "${profile.style.signoffPatterns[0]}"`);
    }

    if (profile.stats.avgResponseTimeHours !== null) {
      const hours = Math.round(profile.stats.avgResponseTimeHours);
      parts.push(
        `Typical response time: ${hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`}`
      );
    }

    return parts.join(" | ");
  }
}
