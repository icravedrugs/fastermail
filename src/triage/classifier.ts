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
  isNewsletter: boolean;
  newsletterConfidence: number;
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
- "link_collection": Newsletter with curated links to external articles/stories. DETECT BY:
  * Subject contains "links", "roundup", "assorted links", "weekly links", "daily links"
  * Preview mentions multiple distinct topics/stories (e.g., "AI news, economics, new study on X")
  * Newsletter format listing several items/articles to read
  * Examples: Marginal Revolution "assorted links", AlphaSignal daily digest, Hacker News digest
- "article": Long-form content, essay, or opinion piece - a SINGLE article/post to read
- "announcement": Public/broadcast message, community call, not personal to recipient
- "transactional": Receipt, confirmation, order status, shipping update

NEWSLETTER DETECTION:
Determine if this email is a newsletter/subscription content. Consider:
- Sender address contains "newsletter", "noreply", "digest", "updates", "info@", "hello@"
- Sender domain is a known newsletter platform (substack.com, beehiiv.com, convertkit.com, mailchimp, etc.)
- Email has subscription/list characteristics (mass-sent, not personal)
- Content format is link_collection or article
- Subject patterns: weekly/daily roundups, issue numbers, edition numbers
Newsletter does NOT include: personal emails, transactional emails (receipts, confirmations), marketing blasts for specific products, account notifications

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
CONTENT_SUMMARY: [2-3 sentences about the CONTENT ONLY. NEVER start with "This email is..." or "This is a...". NEVER describe the email format or sender. Just state what information or topics are covered.
BAD: "This is a newsletter featuring links about AI and economics"
GOOD: "AI regulation updates in Europe. New study shows remote work increases productivity by 13%. Tyler Cowen discusses inflation trends."
BAD: "This email is a shipping notification for an order"
GOOD: "Volvo XC60 rental return confirmed. Fuel dropped from 8/8 to 4/8. Mileage charges may apply."]
LABELS: [comma-separated list of suggested labels like "newsletter", "receipt", "meeting", "personal", etc.]
CONTENT_FORMAT: [one of: standard, link_collection, article, announcement, transactional]
IS_NEWSLETTER: [true or false]
NEWSLETTER_CONFIDENCE: [0.0 to 1.0 - how confident you are about the newsletter classification]`;

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
    let isNewsletter = false;
    let newsletterConfidence = 0.0;

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
      } else if (line.startsWith("IS_NEWSLETTER:")) {
        const value = line.replace("IS_NEWSLETTER:", "").trim().toLowerCase();
        isNewsletter = value === "true";
      } else if (line.startsWith("NEWSLETTER_CONFIDENCE:")) {
        const value = parseFloat(line.replace("NEWSLETTER_CONFIDENCE:", "").trim());
        if (!isNaN(value) && value >= 0 && value <= 1) {
          newsletterConfidence = value;
        }
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
      isNewsletter,
      newsletterConfidence,
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
            isNewsletter: false,
            newsletterConfidence: 0.0,
          });
        }
      });

      await Promise.all(promises);
    }

    return results;
  }
}
