# FasterMail Learning Log

Append-only. Five lines per hypothesis: what, why (with counts), kill criterion, shipped-on, verdict.
Analysis jobs read the most recent "Batch shipped" line to scope their window.

---

**Batch shipped: 2026-08-19, commit 1537190e18f81e026422222262694b30fa024743** — window 2 starts here.
Instrument notes for anyone reading pre/post data:
- Digest times shifted meaning at this commit: `TZ=Europe/London` is now set, so `09:00,18:00` are London times (they were UTC by accident before).
- Action links (`/email-action`, `/r`) are HMAC-signed from this commit; links in digests sent before it return 403. `/cleanup` tokens are unaffected.
- `digest_included` events now count **rendered rows only** (collapsed GitHub threads = one event with `thread_size`); per-email membership remains on `processed_emails.digest_id`.
- Filtered emails now write `classification='skipped'` (`digest_id` NULL). The 28 pre-fix phantom rows (`confidence=1.0 AND reasoning='Already labeled'`, all noam@10ne.org) remain in place as history — exclude them from any classification stats.
- GitHub inherited rows (`reasoning='Thread continuation (classification inherited)'`) carry the **origin** row's `config_hash` and must be excluded from classifier-accuracy stats — the classifier never saw them.
- Known accepted risks: signed action links are still state-changing GETs (no scanner/prefetcher sits in this personal Fastmail path; revisit if mail routing ever changes); a residual ~1e-4/window digest-handover race can orphan an email's digest linkage (hardening idea: self-healing sweep in generateDigest); `code: <digits>` subjects without an auth qualifier still trigger OTP detection ("Locker pickup code: 4832") — mitigated by the unread-and-in-inbox guard on auto-trash, and precision is auditable via `action_taken IN ('otp-bypass','otp-expired','otp-kept')`.

---

**GitHub PR threads collapse to one digest row, classified once per thread.**
Why: 58 emails / 21 threads in window 1; 39 of 277 digest rows (14%) were repeats of a thread already shown; 18 of 21 threads drew inconsistent classifications across their own messages. 14 of 58 read across 5 threads — repetition is the problem, not the sender, so no auto-delete.
Kill: thread-delete clicks stay near zero while per-thread rows keep getting individually deleted, or read-rate on collapsed rows drops materially below window 1's per-message read rate.
Shipped: 2026-08-19, 1537190.
Verdict: —

**Essay senders promote to inbox on a rescue-history allowlist (stratechery, 70s-sci-fi-art, theleverage, readwise).**
Why: all 28 article/link_collection emails in window 1 were classified low-priority; 13 of 16 digest actions on them were rescues; the four allowlisted senders account for 14 of 18 rescues. Allowlist, not content_format: the format signal over-fired on 12 essays nobody touched. Promoted emails keep their digest row ("already in your inbox") so the delete/demote channel survives — the load-bearing Phase-1 rule.
Kill: deletes on promoted digest rows for a sender reach ~50% over a window with n≥5 → demote that sender. Watch the corollary pathology: each promotion shrinks the control population; do not promote a new sender in the same window one was promoted.
Shipped: 2026-08-19, 1537190.
Verdict: —

**One-time codes bypass the digest and auto-trash after 2h (unread-and-in-inbox only).**
Why: 12 OTP emails in window 1, all classified important, digested a median 11.3h after arrival — long expired; 4 explicitly deleted from digests, 8 of 16 never opened. OTP rule takes precedence over sender promotion (70s-sci-fi-art sends both essays and codes). Auto-trash skips anything read or filed (marked `otp-kept`) so false positives are never destroyed unseen-by-choice.
Kill: any `otp-expired` row whose subject was not actually a one-time code (audit each window), or `otp-kept` rate above ~30% (means detection is catching mail people read).
Shipped: 2026-08-19, 1537190.
Verdict: —

**Un-flagging as a rejection signal — NOT ACTED ON.**
Why: all 11 user flag events in window 1 were removals, but FasterMail set 48 flags (every `important`), so the real clear-rate is 23% and 37 flags stood. Clearing a quarter of a to-do marker is what using one looks like.
Kill: per-sender clear rate stays under ~40% for senders with n≥8 across two more windows → drop the idea.
Shipped: not shipped (hypothesis only).
Verdict: revisit window 4.
