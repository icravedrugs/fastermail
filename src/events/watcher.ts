import type { JMAPClient, Email } from "../jmap/index.js";
import type { Store, EmailStateSnapshot } from "../db/index.js";
import type { SelfActionRegistry } from "./registry.js";

const SYNC_STATE_KEY = "events_email_state";
const TRACKED_PROPERTIES = ["id", "mailboxIds", "keywords"];

/**
 * Watches the whole Fastmail account for email state changes via JMAP
 * Email/changes and diffs them against last-known snapshots to produce
 * behavioral events (seen, moved, destroyed, answered, flagged) — no matter
 * which client performed the action. Push (EventSource) gives seconds-level
 * timing resolution; a polling fallback covers push outages.
 */
export class ActivityWatcher {
  private running = false;
  private syncing = false;
  private resyncQueued = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pushAbort: AbortController | null = null;
  private mailboxNames = new Map<string, string>();

  constructor(
    private readonly jmap: JMAPClient,
    private readonly store: Store,
    private readonly selfActions: SelfActionRegistry,
    private readonly pollIntervalSeconds: number
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await this.refreshMailboxNames();

    const persisted = await this.store.getSyncState(SYNC_STATE_KEY);
    if (!persisted) {
      await this.resetBaseline();
    } else {
      await this.sync();
    }

    await this.seedInboxSnapshots();

    void this.runPushLoop();
    this.pollTimer = setInterval(
      () => void this.sync(),
      this.pollIntervalSeconds * 1000
    );

    console.log("Activity watcher started");
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.pollTimer = null;
    this.debounceTimer = null;
    this.pushAbort?.abort();
    console.log("Activity watcher stopped");
  }

  // ============ Push ============

  private async runPushLoop(): Promise<void> {
    let backoffMs = 5000;

    while (this.running) {
      this.pushAbort = new AbortController();
      try {
        await this.jmap.streamEmailChanges(
          () => this.queueSync(),
          this.pushAbort.signal
        );
        backoffMs = 5000;
      } catch (err) {
        if (!this.running) return;
        console.error(
          "Activity watcher push stream error:",
          err instanceof Error ? err.message : err
        );
      }

      if (!this.running) return;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 120_000);
    }
  }

  private queueSync(): void {
    // Debounce bursts of push notifications into one sync
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.sync();
    }, 1000);
  }

  // ============ Sync ============

  private async sync(): Promise<void> {
    if (!this.running) return;
    if (this.syncing) {
      this.resyncQueued = true;
      return;
    }
    this.syncing = true;

    try {
      let state = await this.store.getSyncState(SYNC_STATE_KEY);
      if (!state) return;

      for (;;) {
        let changes;
        try {
          changes = await this.jmap.getEmailChanges(state);
        } catch (err) {
          if (String(err).includes("cannotCalculateChanges")) {
            console.log("Activity watcher: server lost change history, resetting baseline");
            await this.resetBaseline();
            return;
          }
          throw err;
        }

        await this.processChanges(
          changes.created,
          changes.updated,
          changes.destroyed
        );

        state = changes.newState;
        await this.store.setSyncState(SYNC_STATE_KEY, state);

        if (!changes.hasMoreChanges) break;
      }
    } catch (err) {
      console.error("Activity watcher sync error:", err);
    } finally {
      this.syncing = false;
      if (this.resyncQueued) {
        this.resyncQueued = false;
        void this.sync();
      }
    }
  }

  private async processChanges(
    created: string[],
    updated: string[],
    destroyed: string[]
  ): Promise<void> {
    const createdSet = new Set(created);
    const changedIds = [...new Set([...created, ...updated])];
    if (changedIds.length === 0 && destroyed.length === 0) return;

    const emails =
      changedIds.length > 0
        ? await this.jmap.getEmails(changedIds, TRACKED_PROPERTIES)
        : [];
    const snapshots = await this.store.getEmailStateSnapshots([
      ...changedIds,
      ...destroyed,
    ]);

    if (
      emails.some((e) =>
        Object.keys(e.mailboxIds).some((id) => !this.mailboxNames.has(id))
      )
    ) {
      await this.refreshMailboxNames();
    }

    for (const email of emails) {
      const current = this.toSnapshot(email);
      const previous = snapshots.get(email.id);

      if (previous && !createdSet.has(email.id)) {
        await this.emitDiffEvents(previous, current);
      }
      // No previous snapshot: first observation becomes the baseline.
      await this.store.upsertEmailStateSnapshot(current);
    }

    for (const id of destroyed) {
      // Only report emails we were actually tracking; drafts and other
      // transient objects get destroyed constantly.
      if (!snapshots.has(id)) continue;

      await this.store.recordEvent({
        emailId: id,
        type: "destroyed",
        source: this.selfActions.wasRecentlyTouched(id) ? "fastermail" : "user",
      });
      await this.store.deleteEmailStateSnapshot(id);
    }
  }

  private async emitDiffEvents(
    previous: EmailStateSnapshot,
    current: EmailStateSnapshot
  ): Promise<void> {
    const source = this.selfActions.wasRecentlyTouched(current.id)
      ? "fastermail"
      : "user";

    if (!previous.seen && current.seen) {
      await this.store.recordEvent({ emailId: current.id, type: "seen", source });
    }
    if (previous.seen && !current.seen) {
      await this.store.recordEvent({ emailId: current.id, type: "unseen", source });
    }
    if (!previous.answered && current.answered) {
      await this.store.recordEvent({ emailId: current.id, type: "answered", source });
    }
    if (previous.flagged !== current.flagged) {
      await this.store.recordEvent({
        emailId: current.id,
        type: "flagged",
        source,
        detail: { on: current.flagged },
      });
    }

    const previousSet = new Set(previous.mailboxIds);
    const currentSet = new Set(current.mailboxIds);
    const removed = previous.mailboxIds.filter((id) => !currentSet.has(id));
    const added = current.mailboxIds.filter((id) => !previousSet.has(id));

    if (removed.length > 0 || added.length > 0) {
      await this.store.recordEvent({
        emailId: current.id,
        type: "moved",
        source,
        detail: {
          from: removed.map((id) => this.mailboxNames.get(id) ?? id),
          to: added.map((id) => this.mailboxNames.get(id) ?? id),
        },
      });
    }
  }

  // ============ State management ============

  private toSnapshot(email: Email): EmailStateSnapshot {
    return {
      id: email.id,
      mailboxIds: Object.keys(email.mailboxIds)
        .filter((id) => email.mailboxIds[id])
        .sort(),
      seen: Boolean(email.keywords["$seen"]),
      answered: Boolean(email.keywords["$answered"]),
      flagged: Boolean(email.keywords["$flagged"]),
    };
  }

  private async resetBaseline(): Promise<void> {
    const baseline = await this.jmap.getEmailChanges();
    await this.store.setSyncState(SYNC_STATE_KEY, baseline.newState);
    console.log("Activity watcher: baseline email state established");
  }

  private async refreshMailboxNames(): Promise<void> {
    const mailboxes = await this.jmap.getMailboxes();
    this.mailboxNames = new Map(
      mailboxes.map((m) => [m.id, m.role ?? m.name])
    );
  }

  /**
   * Snapshot emails already sitting in the inbox so their first action is
   * diffable, instead of only becoming a baseline. Never overwrites existing
   * snapshots — pending diffs from before a restart must survive.
   */
  private async seedInboxSnapshots(): Promise<void> {
    try {
      const inbox = await this.jmap.findMailboxByRole("inbox");
      if (!inbox) return;

      const ids = await this.jmap.queryEmails(
        { inMailbox: inbox.id },
        { limit: 500 }
      );
      if (ids.length === 0) return;

      const existing = await this.store.getEmailStateSnapshots(ids);
      const missing = ids.filter((id) => !existing.has(id));
      if (missing.length === 0) return;

      const emails = await this.jmap.getEmails(missing, TRACKED_PROPERTIES);
      for (const email of emails) {
        await this.store.upsertEmailStateSnapshot(this.toSnapshot(email));
      }
      console.log(`Activity watcher: seeded ${emails.length} inbox snapshots`);
    } catch (err) {
      console.error("Activity watcher: inbox snapshot seeding failed:", err);
    }
  }
}
