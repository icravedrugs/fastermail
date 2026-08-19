import crypto from "crypto";
import type { ClassifierConfig, CorrectionExample } from "./classifier.js";
import type { Store, Correction } from "../db/index.js";

// NOTE: this file once held a deterministic rule engine (Rule types,
// evaluateCondition, parseCustomRules, applyRules) that was exported but never
// called — every "rule" actually lives as English inside the classifier
// prompt. The dead engine was removed in the window-2 batch; deterministic
// pre-classification now lives in pretriage.ts. customRules strings still
// flow into the prompt via ClassifierConfig below.

export async function buildConfigFromStore(store: Store): Promise<ClassifierConfig> {
  // Get basic config
  const vipSenders = await store.getConfig<string[]>("vipSenders", []);
  const autoArchiveDomains = await store.getConfig<string[]>("autoArchiveDomains", []);
  const customRules = await store.getConfig<string[]>("customRules", []);

  // Get recent corrections and convert to examples
  const recentCorrections = await store.getRecentCorrections(10);
  const corrections: CorrectionExample[] = recentCorrections.map((c) => ({
    emailType: summarizeEmailType(c),
    from: c.originalClassification,
    to: c.correctedClassification,
    reasoning: c.reasoning,
  }));

  return {
    vipSenders,
    autoArchiveDomains,
    customRules,
    corrections,
  };
}

/**
 * Fingerprint of the assembled classifier config, stored on every
 * processed_emails row. The config mutates whenever a correction lands
 * (corrections are spliced into the prompt), so without this no two analysis
 * windows measure the same system.
 */
export function computeConfigHash(config: ClassifierConfig): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(config))
    .digest("hex")
    .slice(0, 12);
}

/**
 * Create a short description of the email type for few-shot learning
 */
function summarizeEmailType(correction: Correction): string {
  const parts: string[] = [];

  // Extract key info from subject
  if (correction.emailSubject) {
    const subject = correction.emailSubject.toLowerCase();
    if (subject.includes("booking") || subject.includes("reservation")) {
      parts.push("booking/reservation");
    } else if (subject.includes("receipt") || subject.includes("invoice")) {
      parts.push("receipt/invoice");
    } else if (subject.includes("newsletter")) {
      parts.push("newsletter");
    } else if (subject.includes("terms") || subject.includes("policy")) {
      parts.push("terms/policy update");
    } else if (subject.includes("calendar") || subject.includes("event")) {
      parts.push("calendar notification");
    } else {
      // Use first few words of subject
      parts.push(correction.emailSubject.slice(0, 40));
    }
  }

  // Add sender context if available
  if (correction.emailFrom) {
    const domain = correction.emailFrom.split("@")[1];
    if (domain) {
      parts.push(`from ${domain}`);
    }
  }

  return parts.join(" ") || "email";
}
