export interface SenderProfile {
  email: string;
  domain: string;
  relationshipType: "service" | "business" | "personal" | "vip" | "unknown";
  style: {
    formality: number; // 0 = very casual, 1 = very formal
    avgResponseLength: number;
    greetingPatterns: string[];
    signoffPatterns: string[];
    usesEmoji: boolean;
    usesExclamations: boolean;
  };
  stats: {
    emailsReceived: number;
    emailsSent: number;
    avgResponseTimeHours: number | null;
    lastInteraction: string | null;
  };
}

export interface EmailAnalysis {
  greetingStyle: string | null;
  signoffStyle: string | null;
  formality: number;
  wordCount: number;
  hasEmoji: boolean;
  hasExclamations: boolean;
  responseTimeHours: number | null;
}

export interface AnalysisSample {
  to: string;
  from: string;
  subject: string | null;
  body: string;
  sentAt: string;
  inReplyTo: string | null;
}
