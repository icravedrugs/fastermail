import type { Email } from "../jmap/index.js";
import type { ClassifierConfig, Classification, CorrectionExample } from "./classifier.js";
import type { Store, Correction } from "../db/index.js";

export interface Rule {
  id: string;
  name: string;
  condition: RuleCondition;
  action: RuleAction;
  priority: number;
}

export type RuleCondition =
  | { type: "from"; pattern: string }
  | { type: "domain"; domain: string }
  | { type: "subject"; pattern: string }
  | { type: "has-attachment"; value: boolean }
  | { type: "and"; conditions: RuleCondition[] }
  | { type: "or"; conditions: RuleCondition[] };

export type RuleAction =
  | { type: "classify"; classification: Classification }
  | { type: "label"; label: string }
  | { type: "skip" };

export function evaluateCondition(
  condition: RuleCondition,
  email: Email
): boolean {
  switch (condition.type) {
    case "from": {
      const from = email.from?.[0]?.email?.toLowerCase() || "";
      return from.includes(condition.pattern.toLowerCase());
    }
    case "domain": {
      const from = email.from?.[0]?.email?.toLowerCase() || "";
      const domain = from.split("@")[1] || "";
      return domain === condition.domain.toLowerCase();
    }
    case "subject": {
      const subject = email.subject?.toLowerCase() || "";
      return subject.includes(condition.pattern.toLowerCase());
    }
    case "has-attachment": {
      return email.hasAttachment === condition.value;
    }
    case "and": {
      return condition.conditions.every((c) => evaluateCondition(c, email));
    }
    case "or": {
      return condition.conditions.some((c) => evaluateCondition(c, email));
    }
  }
}

export function parseCustomRules(rules: string[]): Rule[] {
  const parsedRules: Rule[] = [];

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i].toLowerCase().trim();
    const id = `custom-${i}`;

    // Parse common patterns
    // "emails from X are important"
    const fromImportant = rule.match(
      /emails?\s+from\s+(\S+)\s+(?:are|is)\s+(important|low-priority|fyi)/
    );
    if (fromImportant) {
      parsedRules.push({
        id,
        name: rule,
        condition: { type: "from", pattern: fromImportant[1] },
        action: {
          type: "classify",
          classification: fromImportant[2] as Classification,
        },
        priority: 100,
      });
      continue;
    }

    // "newsletters are low-priority"
    const subjectClass = rule.match(
      /(\w+)\s+(?:are|is)\s+(important|low-priority|fyi|needs-reply)/
    );
    if (subjectClass) {
      parsedRules.push({
        id,
        name: rule,
        condition: { type: "subject", pattern: subjectClass[1] },
        action: {
          type: "classify",
          classification: subjectClass[2] as Classification,
        },
        priority: 50,
      });
      continue;
    }

    // "archive emails from domain.com"
    const archiveDomain = rule.match(
      /archive\s+emails?\s+from\s+(\S+)/
    );
    if (archiveDomain) {
      parsedRules.push({
        id,
        name: rule,
        condition: { type: "domain", domain: archiveDomain[1] },
        action: { type: "classify", classification: "low-priority" },
        priority: 75,
      });
      continue;
    }

    // If we couldn't parse, store as-is for LLM to interpret
    console.log(`Rule not parsed, will be passed to LLM: "${rule}"`);
  }

  return parsedRules.sort((a, b) => b.priority - a.priority);
}

export function applyRules(
  email: Email,
  rules: Rule[]
): { classification?: Classification; labels: string[] } | null {
  const labels: string[] = [];
  let classification: Classification | undefined;

  for (const rule of rules) {
    if (evaluateCondition(rule.condition, email)) {
      switch (rule.action.type) {
        case "classify":
          if (!classification) {
            classification = rule.action.classification;
          }
          break;
        case "label":
          labels.push(rule.action.label);
          break;
        case "skip":
          return null; // Skip this email entirely
      }
    }
  }

  if (classification || labels.length > 0) {
    return { classification, labels };
  }

  return null;
}

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
