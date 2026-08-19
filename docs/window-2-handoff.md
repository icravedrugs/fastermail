# FasterMail — Window 2 handoff

**Written 2026-08-19. For the agent implementing the changes. You have no memory of the analysis session that produced this — everything you need is here.**

## Mission

Apply the learnings from the first 14-day behavioral extraction, then get out of the way so a second
14-day window can measure the result. A scheduled job (`fastermail-window-2-extraction`) fires
**2026-09-05** to run that extraction. Your job is to make sure that job measures something meaningful.

**Scope decision (already made, do not relitigate): ship everything in this batch** — instrument fixes
*and* the three behavioral recommendations, together. Rationale: window 1 was never a valid baseline
(the classifier config mutated on every poll, and event timestamps are sync times), so there is no
clean before/after to preserve. Window 2 becomes the first real baseline; behavioral effects get
measured in window 3.

## Ground rules

1. **Verify every claim below against the code before you change anything.** Line numbers are from
   2026-08-19 and were spot-checked, but they drift. If a claim doesn't hold, say so and stop — do not
   invent a different fix for a problem that isn't there.
2. **Do not build the ceremony.** No `decisions` table, no shadow classification, no per-experiment
   YAML, no per-window markdown reports, no auto-rollback state machine. An earlier design proposed all
   of that and it was cut deliberately: this is one person's ~8k emails/year, and the whole loop will
   produce maybe 5–15 real rules ever. Machinery that doesn't get maintained teaches nothing.
3. **Phase 1 is a hard prerequisite for Phase 2.** Read why below. Shipping the routing changes without
   it destroys the only measurement channel that exists.
4. **Record the ship commit and date in `docs/LEARNING-LOG.md`** (Phase 3). The window-2 job reads that
   file to know when its window started. If it's missing, the job cannot scope itself.
5. There are **zero test files** in this repo. Verify by running against production Turso read-only
   (credentials in `.env`) and by reading the code, not by trusting a green build.

---

## Phase 0 — Instrument fixes (blocking; nothing else matters until these land)

These are why five claims in the window-1 report were wrong. They are not analysis caveats; they mean
a second window would measure the wrong thing.

**0.1 — Stop writing phantom classifications.** `src/triage/engine.ts:177-183`. When a whole fetched
batch is filtered out, every email in it is written as `classification='fyi', confidence=1.0,
reasoning='Already labeled'`. In window 1 this produced **29 fabricated `fyi` rows, all from
`noam@10ne.org`** (the user's own self-addressed mail, correctly skipped by triage). It corrupted the
`fyi` read rate from a true 16% to an apparent 37% and generated an entirely fictitious
recommendation. Either skip the write, or write a distinct `classification='skipped'` that analysis
can exclude. **Do not silently delete the 29 existing rows** — they are the historical record; leave
them and make them identifiable.

**0.2 — Distinguish sync time from action time.** `src/db/store.ts:588-600`: `recordEvent` defaults
`at` to `new Date()`, and `ActivityWatcher` never supplies one, because JMAP's change feed carries no
per-change timestamp. The tell is visible in production: **all 146 user `seen` events in window 1 fall
between seconds 10 and 29 of their minute**, tracking the 60s poll rather than the user. Add an
`observed_at` column to `events`; keep `at` for the moment the action is *claimed* to have happened
(digest clicks are real HTTP request times and ARE accurate — preserve that distinction). Any latency
figure finer than ~1h is at the resolution floor and must not be quoted as precise.

**0.3 — Fix the `resetBaseline` dead-cursor loop.** `src/events/watcher.ts:259-263` calls
`this.jmap.getEmailChanges()` with no argument. `src/jmap/client.ts:286` is
`const state = sinceState ?? this.emailState` — and `this.emailState` still holds the cursor that just
failed. So it re-issues the dead state, throws `cannotCalculateChanges` again, never writes
`sync_state`, and a restart reads the same dead state back. **Recovery currently requires clearing
`sync_state` by hand.** Fix: have `resetBaseline` clear `this.emailState` (or pass an explicit
sentinel) so the `if (!state)` initial-state branch is reachable. Also log loudly when it fires — if it
fired during window 1, part of that event log is silently incomplete and nothing recorded it.

**0.4 — Version the classifier config.** This is the one that makes fortnightly comparison possible at
all. `src/triage/rules.ts:153-175` (`buildConfigFromStore`) splices the 10 most recent corrections into
the classifier prompt on **every poll**. There is no separate rule layer — `applyRules` in
`src/triage/rules.ts:122` is exported from `src/triage/index.ts:11-12` and **called nowhere**. So every
"rule" is English inside a prompt, and the classification policy mutates continuously with no deploy
and no version. Consequence: no two windows measure the same system, and window 1 does not measure the
same system as itself. **Fix: store a hash of the assembled `ClassifierConfig` on every
`processed_emails` row.** (Pinning corrections to window boundaries is the alternative; the hash is
cheaper and loses nothing.) While here, decide the dead-code question: either wire up `applyRules` as a
real deterministic pre-classifier layer, or delete `rules.ts`'s rule engine and stop implying rules
exist separately from the prompt. Do not leave it dead.

**0.5 — Stop destroying the correction signal.** `src/db/store.ts:574-584`
(`updateEmailClassification`) overwrites `classification` in place **and** restamps `processed_at`.
Every corrected email — the highest-signal subset in the corpus — loses both its original
classification and its true arrival-to-triage latency. Add a `base_classification` column, write the
correction there, leave the original intact, and stop touching `processed_at`.

**0.6 — Fix the `digest_included` race.** `src/digest/generator.ts:361-374` re-queries
`getEmailsByDigestId` *after* `generateDigest` has already rendered the body (summarization is several
LLM calls, so the window is wide). Emails triaged during that window get a `digest_included` event
without ever appearing in the digest, inflating the engagement denominator. Capture the rendered set
and emit events from that, not from a re-query.

**0.7 — Set `TZ` explicitly in `render.yaml`.** `src/digest/scheduler.ts:49,84,115` use `setHours()` on
container-local time and no `TZ` is set, so `DIGEST_TIMES=09:00,18:00` are UTC by accident rather than
intent. Set it deliberately to the user's zone (Europe/London) and note in the log that digest times
shifted, so window 2's timing analysis is not confounded by an unannounced change.

**0.8 — Secure the two open endpoints.** Out of scope for the learning loop, in scope for shipping.
`/email-action` (`src/index.ts:248`) and `/r` (`src/index.ts:309`) require **no token**: anyone holding
an email id can delete the user's mail, and `/r` will redirect to any http(s) host. These URLs sit
permanently in the mailbox. Add a signed token (the `digests` table already has a `cleanup_token`
pattern to follow) and restrict `/r` to an allowlist or drop the open-redirect behavior.

---

## Phase 1 — Preserve the measurement channel (must land before Phase 2)

**1.1 — Keep every email in the digest, forever, including promoted ones.**

This is one line in `src/digest/generator.ts` and it is the single most important change in this
handoff. Read why carefully:

Every signal the learning loop has is a **correction** — the user rescuing an email from the digest to
the inbox, deleting from the digest, clearing a flag. Those signals exist only because the agent made a
mistake the user then fixed. **The moment you auto-route Stratechery to the inbox, the rescue clicks
stop — not because the routing got better, but because you removed the opportunity to observe.**
Window 3 would read "rescues fell to zero, the promotion worked" whether or not it did.

`src/digest/generator.ts:55-57` already includes **all** triaged emails except self-sent. So the fix is
a refusal to change: when Phase 2 promotes an email to the inbox, **keep its digest row**, marked
"already in your inbox." The rescue/delete click survives every future routing change, and the
measurement instrument stops depending on the routing decision.

This is why an earlier design's shadow-logging, holdout and "sabbatical window" proposals were all
cut — they were expensive attempts to solve a problem that one line solves better. It also means
**do not** add "exclude from digest" as part of the essay promotion.

---

## Phase 2 — Behavioral changes (the three verified recommendations)

All three were re-verified against the code after the audit and survived. Counts are from
2026-08-05 → 2026-08-19, user-sourced events only (`source='user'`; `source='fastermail'` is the
system's own actions and must be excluded from any behavioral inference).

**2.1 — Collapse GitHub PR notifications to one digest row per thread.** *Highest volume, lowest risk —
do this one first.* 58 emails from `notifications@github.com` represent **21 PR threads** (median 3
messages, max 5); every one is a `Re:` reply. **39 of 277 digest rows (14%) were repeats of a thread
already shown.** And **18 of 21 threads got inconsistent classifications across their own messages** —
one gdiffer PR drew `needs-reply`, `fyi` and `low-priority` on four notifications about the same
conversation. Verified clean: none of the 58 are phantom rows from 0.1.

Build: one digest row per `thread_id` with a message count; one delete action that takes the whole
thread; classification decided once at thread level rather than per message.

**Do not auto-delete GitHub.** 14 of 58 messages were read, spanning 5 of 21 threads. The problem is
repetition, not the sender.

**2.2 — Promote essay newsletters to the inbox, on a sender allowlist.** All **28** emails the
classifier tagged `content_format` `article` or `link_collection` were also classified
**low-priority** — not one was rated higher. Of the 16 that drew any digest action, **13 were
move-to-inbox rescues** and 3 were deletes.

Promote exactly these four senders, which account for 14 of 18 rescues:
`email@stratechery.com` (6 of 9 rescued), `70s-sci-fi-art@ghost.io` (4 of 5),
`theleverage@substack.com` (2 of 2), `hello@readwise.io` (2 of 2).

**Use the sender allowlist, not the `content_format` rule.** The format signal over-fires: 12 of the 28
drew no click at all (Not Boring, Dex Digest, betaworks Bytes, Patreon, MoneySavingExpert all sat
untouched). Keep `content_format` as the *candidate generator* for future windows; gate promotion on
observed rescue history.

Remember Phase 1: promoted emails **stay in the digest**, marked as already in the inbox.

**2.3 — One-time codes bypass the digest entirely.** 12 verification-code emails, all classified
`important`, were placed in a digest a median **11.4h** after arrival (range 3.0–14.4h) — long expired.
8 of 16 auth-code emails were never opened; 4 were explicitly deleted from the digest. Subject-line
detection was sufficient to catch all of them (Booking.com, AmEx SafeKey, Sixt, Ocado, Ghost sign-in).

Build: detect, surface immediately with the code extracted, never digest, auto-delete after a short TTL.

**Interaction to get right: `70s-sci-fi-art@ghost.io` appears in both 2.2 and 2.3** — it sends both
essays (promote) and sign-in codes (bypass). **The OTP rule must take precedence over the sender
promotion.** In window 1 the user deleted that sender's sign-in code from the digest while rescuing its
essays; a naive sender-level promotion would push OTPs to the inbox.

---

## Phase 3 — The ledger

**3.1 — Create `docs/LEARNING-LOG.md`, append-only.** Five lines per hypothesis, nothing more:
what, why (with the counts), what would make me kill it, shipped-on (date + commit SHA), verdict
(blank until decided). No YAML, no statuses, no decision windows.

Seed it with the four entries from this batch (2.1, 2.2, 2.3, and the flag hypothesis below), and
**record the ship date and commit for this batch at the top — the window-2 job reads it to scope its
window.**

One entry must be logged as an open hypothesis rather than a change, because it did not survive audit:

> **Un-flagging as a rejection signal — NOT ACTED ON.** All 11 user `flag` events in window 1 carry
> `detail.on=false`, i.e. every flag action was a removal. But `src/triage/engine.ts:249-251` flags
> **every** email classified `important`, and FasterMail set **48** flags in the window — so the real
> rate is 11 cleared of 48 set, **23%**, and 37 flags stood untouched. Clearing a quarter of a to-do
> marker is what using one looks like. Kill criterion: if per-sender clear rate stays under ~40% for
> senders with n≥8 across two more windows, drop the idea. Revisit window 4.

---

## Verification before you call it done

- [ ] `select count(*) from processed_emails where confidence=1.0 and reasoning='Already labeled' and received_at > '<ship date>'` returns **0**.
- [ ] New `events` rows carry both `at` and `observed_at`.
- [ ] `processed_emails` rows carry a config hash; two rows from different days with different correction history have different hashes.
- [ ] A corrected email retains its `base_classification` and its original `processed_at`.
- [ ] Forcing a `cannotCalculateChanges` path leaves a valid `sync_state`, not a dead cursor.
- [ ] A promoted Stratechery email appears **both** in the inbox and as a digest row marked as already there.
- [ ] A GitHub PR thread with 3+ messages produces exactly **one** digest row.
- [ ] A Booking.com verification code never appears in a digest.
- [ ] `/email-action` and `/r` reject unsigned requests.
- [ ] `docs/LEARNING-LOG.md` exists with the ship date and commit at the top.

## What success looks like

Not "the metrics improved." Window 2's job is to be **the first window that measures a stable system**
— fixed instrument, versioned config, and a digest that retains its measurement channel across routing
changes. If it produces no new findings but the instrument is trustworthy, that is a successful window.
