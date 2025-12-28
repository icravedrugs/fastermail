import Anthropic from "@anthropic-ai/sdk";
import type { Email } from "../jmap/index.js";
import type { SenderProfile } from "../sender/index.js";

export type Classification =
  | "important"
  | "needs-reply"
  | "fyi"
  | "low-priority";

export type ContentFormat =
  | "standard"
  | "link_collection"
  | "article"
  | "announcement"
  | "transactional";

export interface ClassificationResult {
  classification: Classification;
  confidence: number;
  reasoning: string;
  contentSummary: string;
  suggestedLabels: string[];
  contentFormat: ContentFormat;
}

export interface ClassifierConfig {
  vipSenders: string[];
  autoArchiveDomains: string[];
  customRules: string[];
  corrections: CorrectionExample[];
}

export interface CorrectionExample {
  emailType: string; // e.g., "hotel booking confirmation"
  from: string; // Original classification
  to: string; // Corrected classification
  reasoning: string;
}

export class EmailClassifier {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async classify(
    email: Email,
    senderProfile: SenderProfile | null,
    config: ClassifierConfig
  ): Promise<ClassificationResult> {
    const prompt = this.buildPrompt(email, senderProfile, config);

    const response = await this.client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    return this.parseResponse(text);
  }

  private buildPrompt(
    email: Email,
    senderProfile: SenderProfile | null,
    config: ClassifierConfig
  ): string {
    const fromEmail = email.from?.[0]?.email || "unknown";
    const fromName = email.from?.[0]?.name || fromEmail;

    // Check if VIP
    const isVip = config.vipSenders.some(
      (v) => v.toLowerCase() === fromEmail.toLowerCase()
    );

    // Check if auto-archive domain
    const domain = fromEmail.split("@")[1] || "";
    const isAutoArchive = config.autoArchiveDomains.some(
      (d) => d.toLowerCase() === domain.toLowerCase()
    );

    let profileContext = "";
    if (senderProfile) {
      profileContext = `
SENDER RELATIONSHIP CONTEXT:
- Relationship type: ${senderProfile.relationshipType}
- Email history: ${senderProfile.stats.emailsReceived} received, ${senderProfile.stats.emailsSent} sent to them
- Your communication style with them: ${senderProfile.style.formality > 0.7 ? "formal" : senderProfile.style.formality > 0.4 ? "professional" : "casual"}
${senderProfile.stats.avgResponseTimeHours !== null ? `- Your typical response time: ${Math.round(senderProfile.stats.avgResponseTimeHours)} hours` : ""}
`;
    }

    let rulesContext = "";
    if (config.customRules.length > 0) {
      rulesContext = `
USER-DEFINED RULES:
${config.customRules.map((r) => `- ${r}`).join("\n")}
`;
    }

    let correctionsContext = "";
    if (config.corrections && config.corrections.length > 0) {
      correctionsContext = `
LEARNED FROM USER CORRECTIONS (apply these patterns to similar emails):
${config.corrections.map((c) => `- "${c.emailType}" should be ${c.to}, not ${c.from} (reason: ${c.reasoning})`).join("\n")}
`;
    }

    const prompt = `You are an email triage assistant. Classify the following email into one of these categories:

CATEGORIES:
- "important": Urgent or time-sensitive emails that need immediate attention
- "needs-reply": Emails that require a response from the user, but aren't urgent
- "fyi": Informational emails worth reading but don't need action (personal updates, relevant announcements)
- "low-priority": Newsletters, marketing emails, automated notifications, digests, subscription content - these should ALWAYS be low-priority regardless of content quality

IMPORTANT RULES:
- Bills, invoices, and payment due notices are ALWAYS "important" - they are time-sensitive
- Credit card statements and bank statements are ALWAYS "important"
- Newsletters and subscription emails are ALWAYS "low-priority", never "fyi"
- Emails from addresses containing "newsletter", "marketing", "digest" are low-priority
- Bulk/mass emails sent to many recipients are low-priority

CONTENT FORMATS (for digest summarization):
- "standard": Normal email, default treatment
- "link_collection": Newsletter/email with multiple curated links to articles/stories
- "article": Long-form content, essay, or opinion piece
- "announcement": Public/broadcast message, community call, not personal to recipient
- "transactional": Receipt, confirmation, order status, shipping update

EMAIL METADATA:
- From: ${fromName} <${fromEmail}>
- Subject: ${email.subject || "(no subject)"}
- Received: ${email.receivedAt}
- Has attachments: ${email.hasAttachment ? "yes" : "no"}
${isVip ? "- SENDER IS MARKED AS VIP" : ""}
${isAutoArchive ? "- SENDER DOMAIN IS MARKED FOR AUTO-ARCHIVE" : ""}
${profileContext}
${rulesContext}
${correctionsContext}
EMAIL PREVIEW:
${email.preview || "(empty)"}

Based on the email metadata, sender relationship, and content, classify this email.

Respond in this exact format:
CLASSIFICATION: [one of: important, needs-reply, fyi, low-priority]
CONFIDENCE: [0.0 to 1.0]
REASONING: [Brief explanation of why this classification was chosen]
CONTENT_SUMMARY: [2-3 sentence summary of what the email is ABOUT - the actual content, topics discussed, or key information. For newsletters with links, mention the main topics. For articles, state the main argument. Do NOT describe the email type or sender - focus on the content itself.]
LABELS: [comma-separated list of suggested labels like "newsletter", "receipt", "meeting", "personal", etc.]
CONTENT_FORMAT: [one of: standard, link_collection, article, announcement, transactional]`;

    return prompt;
  }

  private parseResponse(text: string): ClassificationResult {
    const lines = text.trim().split("\n");

    let classification: Classification = "fyi";
    let confidence = 0.5;
    let reasoning = "";
    let contentSummary = "";
    let suggestedLabels: string[] = [];
    let contentFormat: ContentFormat = "standard";

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
      } else if (line.startsWith("CONFIDENCE:")) {
        const value = parseFloat(line.replace("CONFIDENCE:", "").trim());
        if (!isNaN(value) && value >= 0 && value <= 1) {
          confidence = value;
        }
      } else if (line.startsWith("REASONING:")) {
        reasoning = line.replace("REASONING:", "").trim();
      } else if (line.startsWith("CONTENT_SUMMARY:")) {
        contentSummary = line.replace("CONTENT_SUMMARY:", "").trim();
      } else if (line.startsWith("LABELS:")) {
        const value = line.replace("LABELS:", "").trim();
        suggestedLabels = value
          .split(",")
          .map((l) => l.trim().toLowerCase())
          .filter((l) => l.length > 0);
      } else if (line.startsWith("CONTENT_FORMAT:")) {
        const value = line.replace("CONTENT_FORMAT:", "").trim().toLowerCase();
        if (
          value === "standard" ||
          value === "link_collection" ||
          value === "article" ||
          value === "announcement" ||
          value === "transactional"
        ) {
          contentFormat = value;
        }
      }
    }

    return {
      classification,
      confidence,
      reasoning,
      contentSummary,
      suggestedLabels,
      contentFormat,
    };
  }

  async classifyBatch(
    emails: Array<{
      email: Email;
      senderProfile: SenderProfile | null;
    }>,
    config: ClassifierConfig
  ): Promise<Map<string, ClassificationResult>> {
    const results = new Map<string, ClassificationResult>();

    // Process in parallel with concurrency limit
    const concurrency = 5;
    const batches: Array<
      Array<{ email: Email; senderProfile: SenderProfile | null }>
    > = [];

    for (let i = 0; i < emails.length; i += concurrency) {
      batches.push(emails.slice(i, i + concurrency));
    }

    for (const batch of batches) {
      const promises = batch.map(async ({ email, senderProfile }) => {
        try {
          const result = await this.classify(email, senderProfile, config);
          results.set(email.id, result);
        } catch (error) {
          console.error(`Failed to classify email ${email.id}:`, error);
          // Default classification on error
          results.set(email.id, {
            classification: "fyi",
            confidence: 0,
            reasoning: "Classification failed",
            contentSummary: "",
            suggestedLabels: [],
            contentFormat: "standard",
          });
        }
      });

      await Promise.all(promises);
    }

    return results;
  }
}
