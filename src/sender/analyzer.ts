import type { EmailAnalysis, AnalysisSample } from "./types.js";

// Common greeting patterns to detect
const GREETING_PATTERNS = [
  /^(hey|hi|hello|dear|good morning|good afternoon|good evening)[\s,!]*/i,
  /^(hey|hi|hello)\s+\w+[,!]?\s*/i, // "Hey John,"
];

// Common sign-off patterns to detect
const SIGNOFF_PATTERNS = [
  /(?:^|\n)(best|regards|cheers|thanks|thank you|sincerely|yours|take care|talk soon|ttyl|xo+|love)[,!]?\s*$/im,
  /(?:^|\n)(best regards|kind regards|warm regards|many thanks|thanks!|thank you!)[,!]?\s*$/im,
];

// Formal language indicators
const FORMAL_INDICATORS = [
  /\bplease\b/gi,
  /\bthank you\b/gi,
  /\bkind regards\b/gi,
  /\bsincerely\b/gi,
  /\bdear\b/gi,
  /\bI would appreciate\b/gi,
  /\bI hope this finds you well\b/gi,
  /\bplease let me know\b/gi,
];

// Casual language indicators
const CASUAL_INDICATORS = [
  /\bhey\b/gi,
  /\byeah\b/gi,
  /\bnope\b/gi,
  /\bthanks!\b/gi,
  /\bawesome\b/gi,
  /\bcool\b/gi,
  /\b(lol|haha|hehe)\b/gi,
  /!{2,}/g, // Multiple exclamation marks
];

// Emoji regex (simplified - matches common emoji ranges)
const EMOJI_REGEX =
  /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu;

export function analyzeEmail(sample: AnalysisSample): EmailAnalysis {
  const body = sample.body;
  const lines = body.split("\n");

  // Detect greeting
  let greetingStyle: string | null = null;
  const firstNonEmptyLine = lines.find((line) => line.trim().length > 0);
  if (firstNonEmptyLine) {
    for (const pattern of GREETING_PATTERNS) {
      const match = firstNonEmptyLine.match(pattern);
      if (match) {
        greetingStyle = normalizeGreeting(match[0]);
        break;
      }
    }
  }

  // Detect sign-off
  let signoffStyle: string | null = null;
  const lastLines = lines.slice(-5).join("\n");
  for (const pattern of SIGNOFF_PATTERNS) {
    const match = lastLines.match(pattern);
    if (match) {
      signoffStyle = normalizeSignoff(match[1]);
      break;
    }
  }

  // Calculate formality score (0-1)
  const formalCount = FORMAL_INDICATORS.reduce((count, pattern) => {
    const matches = body.match(pattern);
    return count + (matches?.length ?? 0);
  }, 0);

  const casualCount = CASUAL_INDICATORS.reduce((count, pattern) => {
    const matches = body.match(pattern);
    return count + (matches?.length ?? 0);
  }, 0);

  const totalIndicators = formalCount + casualCount;
  const formality =
    totalIndicators > 0 ? formalCount / totalIndicators : 0.5;

  // Word count
  const wordCount = body.split(/\s+/).filter((w) => w.length > 0).length;

  // Emoji detection
  const hasEmoji = EMOJI_REGEX.test(body);

  // Exclamation detection (more than just one at end of sentence)
  const exclamationMatches = body.match(/!/g);
  const hasExclamations = (exclamationMatches?.length ?? 0) > 1;

  return {
    greetingStyle,
    signoffStyle,
    formality,
    wordCount,
    hasEmoji,
    hasExclamations,
    responseTimeHours: null, // Computed separately when we have thread context
  };
}

function normalizeGreeting(greeting: string): string {
  const normalized = greeting.trim().toLowerCase();

  if (normalized.startsWith("hey ") || normalized === "hey") {
    return normalized.includes(" ") ? "Hey {name}" : "Hey";
  }
  if (normalized.startsWith("hi ") || normalized === "hi") {
    return normalized.includes(" ") ? "Hi {name}" : "Hi";
  }
  if (normalized.startsWith("hello ") || normalized === "hello") {
    return normalized.includes(" ") ? "Hello {name}" : "Hello";
  }
  if (normalized.startsWith("dear ")) {
    return "Dear {name}";
  }
  if (normalized.includes("good morning")) return "Good morning";
  if (normalized.includes("good afternoon")) return "Good afternoon";
  if (normalized.includes("good evening")) return "Good evening";

  return greeting.trim();
}

function normalizeSignoff(signoff: string): string {
  const normalized = signoff.trim().toLowerCase();

  const mappings: Record<string, string> = {
    "best": "Best",
    "best regards": "Best regards",
    "kind regards": "Kind regards",
    "warm regards": "Warm regards",
    "regards": "Regards",
    "cheers": "Cheers",
    "thanks": "Thanks",
    "thanks!": "Thanks!",
    "thank you": "Thank you",
    "thank you!": "Thank you!",
    "many thanks": "Many thanks",
    "sincerely": "Sincerely",
    "yours": "Yours",
    "take care": "Take care",
    "talk soon": "Talk soon",
    "ttyl": "TTYL",
    "xo": "xo",
    "xox": "xox",
    "xoxo": "xoxo",
    "love": "Love",
  };

  return mappings[normalized] ?? signoff.trim();
}

export function aggregateAnalyses(analyses: EmailAnalysis[]): {
  avgFormality: number;
  avgWordCount: number;
  greetingPatterns: string[];
  signoffPatterns: string[];
  usesEmoji: boolean;
  usesExclamations: boolean;
} {
  if (analyses.length === 0) {
    return {
      avgFormality: 0.5,
      avgWordCount: 0,
      greetingPatterns: [],
      signoffPatterns: [],
      usesEmoji: false,
      usesExclamations: false,
    };
  }

  const avgFormality =
    analyses.reduce((sum, a) => sum + a.formality, 0) / analyses.length;

  const avgWordCount =
    analyses.reduce((sum, a) => sum + a.wordCount, 0) / analyses.length;

  // Count greeting patterns
  const greetingCounts = new Map<string, number>();
  for (const a of analyses) {
    if (a.greetingStyle) {
      greetingCounts.set(
        a.greetingStyle,
        (greetingCounts.get(a.greetingStyle) ?? 0) + 1
      );
    }
  }
  const greetingPatterns = [...greetingCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([pattern]) => pattern);

  // Count sign-off patterns
  const signoffCounts = new Map<string, number>();
  for (const a of analyses) {
    if (a.signoffStyle) {
      signoffCounts.set(
        a.signoffStyle,
        (signoffCounts.get(a.signoffStyle) ?? 0) + 1
      );
    }
  }
  const signoffPatterns = [...signoffCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([pattern]) => pattern);

  // Boolean flags - true if used in >30% of emails
  const usesEmoji =
    analyses.filter((a) => a.hasEmoji).length / analyses.length > 0.3;
  const usesExclamations =
    analyses.filter((a) => a.hasExclamations).length / analyses.length > 0.3;

  return {
    avgFormality,
    avgWordCount,
    greetingPatterns,
    signoffPatterns,
    usesEmoji,
    usesExclamations,
  };
}

export function inferRelationshipType(
  domain: string,
  avgFormality: number,
  emailsReceived: number,
  emailsSent: number
): "service" | "business" | "personal" | "vip" | "unknown" {
  // Common service provider domains
  const serviceProviderDomains = [
    "noreply",
    "no-reply",
    "notifications",
    "support",
    "help",
    "billing",
    "accounts",
    "newsletter",
    "marketing",
    "info",
    "updates",
  ];

  const emailParts = domain.toLowerCase();
  const isServiceProvider = serviceProviderDomains.some(
    (s) => emailParts.includes(s)
  );

  if (isServiceProvider) {
    return "service";
  }

  // High reply ratio + casual = personal
  const replyRatio = emailsSent / Math.max(emailsReceived, 1);
  if (replyRatio > 0.5 && avgFormality < 0.4) {
    return "personal";
  }

  // High reply ratio + formal = business
  if (replyRatio > 0.3 && avgFormality >= 0.4) {
    return "business";
  }

  // Low reply ratio = likely service or marketing
  if (replyRatio < 0.1 && emailsReceived > 5) {
    return "service";
  }

  return "unknown";
}
