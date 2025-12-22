import {
  JMAPSession,
  JMAPRequest,
  JMAPResponse,
  JMAPMethodCall,
  Email,
  Mailbox,
  EmailQueryFilter,
  EmailChanges,
  Identity,
} from "./types.js";

export class JMAPClient {
  private session: JMAPSession | null = null;
  private accountId: string | null = null;
  private emailState: string | null = null;

  constructor(
    private readonly sessionUrl: string,
    private readonly token: string
  ) {}

  private async fetch<T>(
    url: string,
    options: RequestInit = {}
  ): Promise<T> {
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`JMAP request failed: ${response.status} ${text}`);
    }

    return response.json() as Promise<T>;
  }

  async connect(): Promise<void> {
    this.session = await this.fetch<JMAPSession>(this.sessionUrl);

    // Get primary mail account
    const mailCapability = "urn:ietf:params:jmap:mail";
    this.accountId = this.session.primaryAccounts[mailCapability];

    if (!this.accountId) {
      throw new Error("No mail account found in JMAP session");
    }

    console.log(`Connected to JMAP as ${this.session.username}`);
    console.log(`Account ID: ${this.accountId}`);
  }

  private async request(methodCalls: JMAPMethodCall[]): Promise<JMAPResponse> {
    if (!this.session) {
      throw new Error("Not connected. Call connect() first.");
    }

    const request: JMAPRequest = {
      using: [
        "urn:ietf:params:jmap:core",
        "urn:ietf:params:jmap:mail",
        "urn:ietf:params:jmap:submission",
      ],
      methodCalls,
    };

    return this.fetch<JMAPResponse>(this.session.apiUrl, {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  get connected(): boolean {
    return this.session !== null && this.accountId !== null;
  }

  // ============ Mailbox Operations ============

  async getMailboxes(): Promise<Mailbox[]> {
    const response = await this.request([
      [
        "Mailbox/get",
        {
          accountId: this.accountId,
        },
        "0",
      ],
    ]);

    const result = response.methodResponses[0];
    if (result[0] === "error") {
      throw new Error(`Mailbox/get failed: ${JSON.stringify(result[1])}`);
    }

    return (result[1] as { list: Mailbox[] }).list;
  }

  async findMailboxByRole(role: string): Promise<Mailbox | undefined> {
    const mailboxes = await this.getMailboxes();
    return mailboxes.find((m) => m.role === role);
  }

  async findMailboxByName(name: string): Promise<Mailbox | undefined> {
    const mailboxes = await this.getMailboxes();
    return mailboxes.find((m) => m.name.toLowerCase() === name.toLowerCase());
  }

  async createMailbox(name: string, parentId?: string): Promise<Mailbox> {
    const response = await this.request([
      [
        "Mailbox/set",
        {
          accountId: this.accountId,
          create: {
            new: {
              name,
              parentId: parentId ?? null,
            },
          },
        },
        "0",
      ],
    ]);

    const result = response.methodResponses[0];
    if (result[0] === "error") {
      throw new Error(`Mailbox/set failed: ${JSON.stringify(result[1])}`);
    }

    const setResult = result[1] as { created?: Record<string, Mailbox> };
    if (!setResult.created?.new) {
      throw new Error("Failed to create mailbox");
    }

    return setResult.created.new;
  }

  async deleteMailbox(mailboxId: string): Promise<void> {
    const response = await this.request([
      [
        "Mailbox/set",
        {
          accountId: this.accountId,
          destroy: [mailboxId],
        },
        "0",
      ],
    ]);

    const result = response.methodResponses[0];
    if (result[0] === "error") {
      throw new Error(`Mailbox/set destroy failed: ${JSON.stringify(result[1])}`);
    }
  }

  // ============ Email Query Operations ============

  async queryEmails(
    filter: EmailQueryFilter,
    options: { limit?: number; position?: number; sort?: Array<{ property: string; isAscending?: boolean }> } = {}
  ): Promise<string[]> {
    const response = await this.request([
      [
        "Email/query",
        {
          accountId: this.accountId,
          filter,
          sort: options.sort ?? [{ property: "receivedAt", isAscending: false }],
          limit: options.limit ?? 50,
          position: options.position ?? 0,
        },
        "0",
      ],
    ]);

    const result = response.methodResponses[0];
    if (result[0] === "error") {
      throw new Error(`Email/query failed: ${JSON.stringify(result[1])}`);
    }

    return (result[1] as { ids: string[] }).ids;
  }

  async getEmails(
    ids: string[],
    properties?: string[]
  ): Promise<Email[]> {
    if (ids.length === 0) return [];

    const defaultProperties = [
      "id",
      "blobId",
      "threadId",
      "mailboxIds",
      "keywords",
      "size",
      "receivedAt",
      "from",
      "to",
      "cc",
      "subject",
      "sentAt",
      "hasAttachment",
      "preview",
    ];

    const response = await this.request([
      [
        "Email/get",
        {
          accountId: this.accountId,
          ids,
          properties: properties ?? defaultProperties,
        },
        "0",
      ],
    ]);

    const result = response.methodResponses[0];
    if (result[0] === "error") {
      throw new Error(`Email/get failed: ${JSON.stringify(result[1])}`);
    }

    return (result[1] as { list: Email[] }).list;
  }

  async getEmailBody(id: string): Promise<Email> {
    const emails = await this.getEmails([id], [
      "id",
      "from",
      "to",
      "cc",
      "subject",
      "receivedAt",
      "preview",
      "bodyValues",
      "textBody",
      "htmlBody",
    ]);

    if (emails.length === 0) {
      throw new Error(`Email not found: ${id}`);
    }

    return emails[0];
  }

  // ============ Email Changes (Sync) ============

  async getEmailChanges(sinceState?: string): Promise<EmailChanges> {
    const state = sinceState ?? this.emailState;

    if (!state) {
      // Get initial state
      const response = await this.request([
        [
          "Email/get",
          {
            accountId: this.accountId,
            ids: [],
          },
          "0",
        ],
      ]);

      const result = response.methodResponses[0];
      this.emailState = (result[1] as { state: string }).state;

      return {
        accountId: this.accountId!,
        oldState: "",
        newState: this.emailState,
        hasMoreChanges: false,
        created: [],
        updated: [],
        destroyed: [],
      };
    }

    const response = await this.request([
      [
        "Email/changes",
        {
          accountId: this.accountId,
          sinceState: state,
        },
        "0",
      ],
    ]);

    const result = response.methodResponses[0];
    if (result[0] === "error") {
      throw new Error(`Email/changes failed: ${JSON.stringify(result[1])}`);
    }

    const changes = result[1] as unknown as EmailChanges;
    this.emailState = changes.newState;

    return changes;
  }

  // ============ Email Modification Operations ============

  async setEmailKeywords(
    emailId: string,
    keywords: Record<string, boolean>
  ): Promise<void> {
    const response = await this.request([
      [
        "Email/set",
        {
          accountId: this.accountId,
          update: {
            [emailId]: { keywords },
          },
        },
        "0",
      ],
    ]);

    const result = response.methodResponses[0];
    if (result[0] === "error") {
      throw new Error(`Email/set failed: ${JSON.stringify(result[1])}`);
    }

    const setResult = result[1] as { notUpdated?: Record<string, unknown> };
    if (setResult.notUpdated?.[emailId]) {
      throw new Error(
        `Failed to update email: ${JSON.stringify(setResult.notUpdated[emailId])}`
      );
    }
  }

  async addEmailKeyword(emailId: string, keyword: string): Promise<void> {
    const response = await this.request([
      [
        "Email/set",
        {
          accountId: this.accountId,
          update: {
            [emailId]: {
              [`keywords/${keyword}`]: true,
            },
          },
        },
        "0",
      ],
    ]);

    const result = response.methodResponses[0];
    if (result[0] === "error") {
      throw new Error(`Email/set failed: ${JSON.stringify(result[1])}`);
    }
  }

  async removeEmailKeyword(emailId: string, keyword: string): Promise<void> {
    const response = await this.request([
      [
        "Email/set",
        {
          accountId: this.accountId,
          update: {
            [emailId]: {
              [`keywords/${keyword}`]: null,
            },
          },
        },
        "0",
      ],
    ]);

    const result = response.methodResponses[0];
    if (result[0] === "error") {
      throw new Error(`Email/set failed: ${JSON.stringify(result[1])}`);
    }
  }

  async moveEmail(emailId: string, toMailboxId: string): Promise<void> {
    const emails = await this.getEmails([emailId], ["mailboxIds"]);
    if (emails.length === 0) {
      throw new Error(`Email not found: ${emailId}`);
    }

    const currentMailboxIds = emails[0].mailboxIds;
    const newMailboxIds: Record<string, boolean> = { [toMailboxId]: true };

    // Remove from current mailboxes
    for (const id of Object.keys(currentMailboxIds)) {
      if (id !== toMailboxId) {
        newMailboxIds[id] = false;
      }
    }

    const response = await this.request([
      [
        "Email/set",
        {
          accountId: this.accountId,
          update: {
            [emailId]: { mailboxIds: { [toMailboxId]: true } },
          },
        },
        "0",
      ],
    ]);

    const result = response.methodResponses[0];
    if (result[0] === "error") {
      throw new Error(`Email/set failed: ${JSON.stringify(result[1])}`);
    }
  }

  async archiveEmail(emailId: string): Promise<void> {
    const archive = await this.findMailboxByRole("archive");
    if (!archive) {
      throw new Error("Archive mailbox not found");
    }
    await this.moveEmail(emailId, archive.id);
  }

  async addEmailToMailbox(emailId: string, mailboxId: string): Promise<void> {
    // Add email to mailbox without removing from other mailboxes (for labels)
    const response = await this.request([
      [
        "Email/set",
        {
          accountId: this.accountId,
          update: {
            [emailId]: {
              [`mailboxIds/${mailboxId}`]: true,
            },
          },
        },
        "0",
      ],
    ]);

    const result = response.methodResponses[0];
    if (result[0] === "error") {
      throw new Error(`Email/set failed: ${JSON.stringify(result[1])}`);
    }
  }

  async removeEmailFromMailbox(emailId: string, mailboxId: string): Promise<void> {
    const response = await this.request([
      [
        "Email/set",
        {
          accountId: this.accountId,
          update: {
            [emailId]: {
              [`mailboxIds/${mailboxId}`]: null,
            },
          },
        },
        "0",
      ],
    ]);

    const result = response.methodResponses[0];
    if (result[0] === "error") {
      throw new Error(`Email/set failed: ${JSON.stringify(result[1])}`);
    }
  }

  // ============ Email Creation (for sending) ============

  async createDraft(email: {
    to: Array<{ name?: string; email: string }>;
    cc?: Array<{ name?: string; email: string }>;
    bcc?: Array<{ name?: string; email: string }>;
    subject: string;
    textBody: string;
    htmlBody?: string;
    inReplyTo?: string;
    references?: string[];
  }): Promise<string> {
    const drafts = await this.findMailboxByRole("drafts");
    if (!drafts) {
      throw new Error("Drafts mailbox not found");
    }

    const bodyParts: Array<{ partId: string; type: string }> = [];
    const bodyValues: Record<string, { value: string }> = {};

    bodyParts.push({ partId: "text", type: "text/plain" });
    bodyValues["text"] = { value: email.textBody };

    if (email.htmlBody) {
      bodyParts.push({ partId: "html", type: "text/html" });
      bodyValues["html"] = { value: email.htmlBody };
    }

    const response = await this.request([
      [
        "Email/set",
        {
          accountId: this.accountId,
          create: {
            draft: {
              mailboxIds: { [drafts.id]: true },
              to: email.to.map((a) => ({ name: a.name ?? null, email: a.email })),
              cc: email.cc?.map((a) => ({ name: a.name ?? null, email: a.email })),
              bcc: email.bcc?.map((a) => ({ name: a.name ?? null, email: a.email })),
              subject: email.subject,
              inReplyTo: email.inReplyTo ? [email.inReplyTo] : null,
              references: email.references ?? null,
              bodyStructure:
                bodyParts.length > 1
                  ? {
                      type: "multipart/alternative",
                      subParts: bodyParts,
                    }
                  : bodyParts[0],
              bodyValues,
            },
          },
        },
        "0",
      ],
    ]);

    const result = response.methodResponses[0];
    if (result[0] === "error") {
      throw new Error(`Email/set failed: ${JSON.stringify(result[1])}`);
    }

    const setResult = result[1] as { created?: Record<string, { id: string }> };
    if (!setResult.created?.draft) {
      throw new Error("Failed to create draft");
    }

    return setResult.created.draft.id;
  }

  async sendEmail(draftId: string): Promise<string> {
    const identities = await this.getIdentities();
    if (identities.length === 0) {
      throw new Error("No sending identity found");
    }

    console.log(`[JMAP] EmailSubmission/set starting for draft ${draftId}`);

    const response = await this.request([
      [
        "EmailSubmission/set",
        {
          accountId: this.accountId,
          create: {
            submission: {
              identityId: identities[0].id,
              emailId: draftId,
            },
          },
          // Clean up the draft after successful send to prevent orphaned drafts
          // #submission refers to the emailId of the created submission
          onSuccessDestroyEmail: ["#submission"],
        },
        "0",
      ],
    ]);

    const result = response.methodResponses[0];
    console.log(`[JMAP] EmailSubmission/set response: ${JSON.stringify(result)}`);

    if (result[0] === "error") {
      throw new Error(`EmailSubmission/set failed: ${JSON.stringify(result[1])}`);
    }

    const setResult = result[1] as { created?: Record<string, { id: string }> };
    const submissionId = setResult.created?.submission?.id || "unknown";
    console.log(`[JMAP] Submission created with ID: ${submissionId}`);

    return submissionId;
  }

  async getIdentities(): Promise<Identity[]> {
    const response = await this.request([
      [
        "Identity/get",
        {
          accountId: this.accountId,
        },
        "0",
      ],
    ]);

    const result = response.methodResponses[0];
    if (result[0] === "error") {
      throw new Error(`Identity/get failed: ${JSON.stringify(result[1])}`);
    }

    return (result[1] as { list: Identity[] }).list;
  }

  // ============ Utility Methods ============

  getAccountId(): string {
    if (!this.accountId) {
      throw new Error("Not connected");
    }
    return this.accountId;
  }

  getCurrentState(): string | null {
    return this.emailState;
  }
}
