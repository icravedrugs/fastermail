// JMAP Core Types (RFC 8620)

export interface JMAPSession {
  capabilities: Record<string, unknown>;
  accounts: Record<string, JMAPAccount>;
  primaryAccounts: Record<string, string>;
  username: string;
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  eventSourceUrl: string;
  state: string;
}

export interface JMAPAccount {
  name: string;
  isPersonal: boolean;
  isReadOnly: boolean;
  accountCapabilities: Record<string, unknown>;
}

export interface JMAPRequest {
  using: string[];
  methodCalls: JMAPMethodCall[];
}

export type JMAPMethodCall = [string, Record<string, unknown>, string];

export interface JMAPResponse {
  methodResponses: JMAPMethodResponse[];
  sessionState: string;
}

export type JMAPMethodResponse = [string, Record<string, unknown>, string];

// JMAP Mail Types (RFC 8621)

export interface Email {
  id: string;
  blobId: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  size: number;
  receivedAt: string;
  messageId: string[] | null;
  inReplyTo: string[] | null;
  references: string[] | null;
  sender: EmailAddress[] | null;
  from: EmailAddress[] | null;
  to: EmailAddress[] | null;
  cc: EmailAddress[] | null;
  bcc: EmailAddress[] | null;
  replyTo: EmailAddress[] | null;
  subject: string | null;
  sentAt: string | null;
  hasAttachment: boolean;
  preview: string;
  bodyValues?: Record<string, EmailBodyValue>;
  textBody?: EmailBodyPart[];
  htmlBody?: EmailBodyPart[];
  attachments?: EmailBodyPart[];
}

export interface EmailAddress {
  name: string | null;
  email: string;
}

export interface EmailBodyValue {
  value: string;
  isEncodingProblem: boolean;
  isTruncated: boolean;
}

export interface EmailBodyPart {
  partId: string | null;
  blobId: string | null;
  size: number;
  name: string | null;
  type: string;
  charset: string | null;
  disposition: string | null;
  cid: string | null;
  language: string[] | null;
  location: string | null;
  subParts?: EmailBodyPart[];
}

export interface Mailbox {
  id: string;
  name: string;
  parentId: string | null;
  role: MailboxRole | null;
  sortOrder: number;
  totalEmails: number;
  unreadEmails: number;
  totalThreads: number;
  unreadThreads: number;
  myRights: MailboxRights;
  isSubscribed: boolean;
}

export type MailboxRole =
  | "all"
  | "archive"
  | "drafts"
  | "flagged"
  | "important"
  | "inbox"
  | "junk"
  | "sent"
  | "subscribed"
  | "trash"
  | null;

export interface MailboxRights {
  mayReadItems: boolean;
  mayAddItems: boolean;
  mayRemoveItems: boolean;
  maySetSeen: boolean;
  maySetKeywords: boolean;
  mayCreateChild: boolean;
  mayRename: boolean;
  mayDelete: boolean;
  maySubmit: boolean;
}

// Email Query and Filter Types

export interface EmailQueryFilter {
  inMailbox?: string;
  inMailboxOtherThan?: string[];
  before?: string;
  after?: string;
  minSize?: number;
  maxSize?: number;
  allInThreadHaveKeyword?: string;
  someInThreadHaveKeyword?: string;
  noneInThreadHaveKeyword?: string;
  hasKeyword?: string;
  notKeyword?: string;
  hasAttachment?: boolean;
  text?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  header?: [string, string];
}

export interface EmailQueryFilterCondition extends EmailQueryFilter {
  operator?: "AND" | "OR" | "NOT";
  conditions?: EmailQueryFilterCondition[];
}

// Email Changes (for sync)

export interface EmailChanges {
  accountId: string;
  oldState: string;
  newState: string;
  hasMoreChanges: boolean;
  created: string[];
  updated: string[];
  destroyed: string[];
}

// Email Set (for modifications)

export interface EmailSetRequest {
  accountId: string;
  ifInState?: string;
  create?: Record<string, Partial<Email>>;
  update?: Record<string, Partial<Email>>;
  destroy?: string[];
}

export interface EmailSetResponse {
  accountId: string;
  oldState: string;
  newState: string;
  created?: Record<string, Email>;
  updated?: Record<string, Email | null>;
  destroyed?: string[];
  notCreated?: Record<string, JMAPSetError>;
  notUpdated?: Record<string, JMAPSetError>;
  notDestroyed?: Record<string, JMAPSetError>;
}

export interface JMAPSetError {
  type: string;
  description?: string;
  properties?: string[];
}

// Submission for sending emails

export interface EmailSubmission {
  id: string;
  identityId: string;
  emailId: string;
  threadId: string;
  envelope?: EmailEnvelope;
  sendAt: string;
  undoStatus: "pending" | "final" | "canceled";
  deliveryStatus: Record<string, DeliveryStatus>;
  dsnBlobIds: string[];
  mdnBlobIds: string[];
}

export interface EmailEnvelope {
  mailFrom: EmailSubmissionAddress;
  rcptTo: EmailSubmissionAddress[];
}

export interface EmailSubmissionAddress {
  email: string;
  parameters?: Record<string, string>;
}

export interface DeliveryStatus {
  smtpReply: string;
  delivered: "unknown" | "queued" | "yes" | "no";
  displayed: "unknown" | "yes";
}

// Identity for sending

export interface Identity {
  id: string;
  name: string;
  email: string;
  replyTo: EmailAddress[] | null;
  bcc: EmailAddress[] | null;
  textSignature: string;
  htmlSignature: string;
  mayDelete: boolean;
}
