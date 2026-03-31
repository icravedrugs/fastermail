---
title: "feat: Newsletter intelligence with Readwise routing"
type: feat
status: completed
date: 2026-03-31
origin: docs/brainstorms/2026-03-30-newsletter-intelligence-requirements.md
deepened: 2026-03-31
---

# feat: Newsletter intelligence with Readwise routing

## Overview

Rework Fastermail from a 4-bucket email classifier into a newsletter intelligence agent. Newsletters get read by the agent, their links/insights extracted and classified by relevance, and the best items routed to Readwise Reader. The digest becomes a brief status report. A correction web UI replaces folder-based corrections for newsletter items.

Operational email handling (important/needs-reply) stays unchanged.

## Problem Frame

The current system classifies newsletters as "low-priority" or "fyi" and dumps them into a digest — but the user still has to triage the digest to find what matters. Newsletters are the bulk of email and the source of overwhelm. The fix is to extract the signal, route it to where the user actually reads (Readwise Reader), and get newsletters out of email entirely. (see origin: docs/brainstorms/2026-03-30-newsletter-intelligence-requirements.md)

## Requirements Trace

- R1. Identify newsletters vs. operational email
- R2. Extract individual links/insights from each newsletter
- R3. Classify each item into must-read / nice-to-have / skip using a reader profile
- R4. Save must-read and nice-to-have items to Readwise Reader with tier, source, and topic tags
- R5. Archive newsletter after processing
- R6. Use a user-provided reader profile markdown file
- R7. Reader profile is primary input for relevance scoring
- R8. Web UI for reviewing and reclassifying extracted items
- R9. Corrections stored and used as few-shot examples
- R10. Digest becomes a status report (counts, uncertain items, correction UI link)
- R11. Digest still includes operational email summaries
- R12. Important/needs-reply emails stay in inbox (unchanged)
- R13. Non-newsletter fyi/low-priority handled as today (unchanged)

## Scope Boundaries

- Not changing: operational email classification, JMAP integration, polling loop core, cleanup system
- Not building: auto-reply, auto-unsubscribe, newsletter recommendation engine, behavioral learning
- Not solving: Readwise reading habits
- Deferred: Readwise item removal on demotion corrections (too destructive, would need Readwise delete API)

## Context & Research

### Relevant Code and Patterns

- **Link extraction pipeline** (`src/digest/strategies.ts`): Two-phase regex + LLM extraction already exists. `extractLinksWithLLM` returns structured JSON with index, title, description. Foundation for R2. Note: this function is currently internal to `strategies.ts` — it needs to be extracted to `src/digest/link-extractor.ts` (which already exists and is exported from the barrel) or re-exported so the newsletter module can import it cleanly.
- **URL redirect resolution** (`src/digest/strategies.ts:92-200`): Resolves Substack/Mailchimp tracking URLs to real destinations with SSRF protection. Essential for Readwise — it needs clean URLs.
- **Content format detection** (`src/triage/classifier.ts`): Already outputs `contentFormat` field distinguishing `link_collection`, `article`, `announcement`, `transactional`, `standard`. Foundation for newsletter identification (R1).
- **Correction-to-few-shot pipeline** (`src/triage/rules.ts:153-174`): Stores corrections in DB, summarizes into descriptions, injects into classifier prompt. Reuse this pattern for tier corrections (R9).
- **Batch classification** (`src/triage/classifier.ts:234-277`): Concurrency-limited (5) LLM calls with error fallbacks. Reuse for batch relevance scoring.
- **HTTP server** (`src/index.ts`): Raw `http.createServer` with inline HTML, manual URL parsing, GET-only endpoints. The correction web UI follows this same pattern. Note: all HTTP handling currently lives in `src/index.ts` — route handlers can be extracted to helper functions but routing stays in index.
- **Database** (`src/db/schema.ts`, `src/db/store.ts`): Turso/libSQL, raw SQL, try/catch ALTER TABLE migrations. DB row types defined in `store.ts`, not module-specific type files.
- **Email body fetching** (`src/jmap/client.ts`): `getEmailBody(id)` is a separate call from `getEmails()`. The triage engine currently only fetches metadata+preview; bodies are fetched later by the digest generator. Newsletters will need eager body fetching during triage.

### External References

- **Readwise Reader API**: `POST https://readwise.io/api/v3/save/` — saves URL with `tags[]`, `notes`, `location` (new/later), `saved_using`, `category`. Returns `{id, url}`. 50 saves/min rate limit. Token auth via `Authorization: Token <token>`. 200 = already exists, 201 = created.
- **Readwise update API**: `PATCH /api/v3/update/<id>/` — replaces all tags (not additive). Useful for retroactive corrections. Check `saved_using` field before PATCHing to avoid modifying user-saved documents.
- **No official SDK**: Raw fetch is the right approach given the project's minimal dependency philosophy.

## Key Technical Decisions

- **Readwise `location` field for tier differentiation**: Must-read items saved with `location: "new"` (appears in Reader inbox), nice-to-have with `location: "later"` (Reader shelf). This uses Readwise's own triage system rather than relying solely on tags.
- **Tag namespacing**: Use prefixes to avoid collisions with manually-created Readwise tags: `tier:must-read`, `tier:nice-to-have`, `src:<newsletter-slug>`, `topic:<topic>`. Plus `saved_using: "fastermail"` on every save for attribution.
- **Semi-constrained topic taxonomy**: The LLM selects topics from the reader profile's focus areas and interests. The profile defines the topic vocabulary, preventing unbounded tag sprawl in Readwise.
- **Reader profile as local markdown file**: Environment variable `READER_PROFILE_PATH` points to a file on disk, re-read on each poll cycle so edits take effect without restart. Simple and fits the deployment model.
- **Newsletter detection via existing `contentFormat` + enhanced heuristics**: Extend the classifier to output an explicit `isNewsletter` boolean alongside `contentFormat`. Use sender domain patterns (noreply, newsletter subdomains), List-Unsubscribe headers, and content format as signals.
- **Newsletter confidence gate**: If the classifier's newsletter detection confidence is below a threshold, the email falls through to the operational path even if `isNewsletter` is true. This prevents false-positive archiving of important emails. Uncertain newsletters are surfaced in the digest for user review.
- **Non-linkable content handling**: For essay-style newsletters with no external links, save the newsletter's own "view in browser" URL (or Fastmail webmail URL) to Readwise as a single item.
- **Retry-on-failure for Readwise saves with budget**: Store items with `readwise_status: "pending"` in DB. On first attempt, transition to `"saved"` or `"failed"`. Retry failed items on subsequent poll cycles with max 10 retries and exponential backoff (skip 1, 2, 4, 8... cycles). After 10 failures, mark as `"abandoned"`. Surface failures and abandoned items in digest.
- **Correction web UI on existing HTTP server**: No separate frontend. Inline HTML like existing endpoints. Token-based access: digest email contains a unique correction UI link, valid for a configurable period. HTML generation extracted to a helper function in `src/newsletter/`, routing stays in `src/index.ts`.
- **Two correction systems coexist**: Folder-based corrections continue for email-level classification (important/fyi/etc). Web UI handles item-level tier corrections (must-read/nice-to-have/skip). Different granularity, different targets. The folder-based `CorrectionProcessor` should skip newsletters (emails where `isNewsletter` was true) since those are already archived and their items managed via the web UI.
- **Retroactive Readwise saves on promotion**: When user promotes a "skip" to "must-read" or "nice-to-have", save it to Readwise retroactively. Demotions do NOT remove from Readwise (too destructive) — just update tags via PATCH (only if `saved_using: "fastermail"` to avoid modifying user-saved docs).
- **Stick with Haiku for all LLM calls**: The existing link extraction with Haiku works well. Relevance scoring adds the reader profile to the prompt but Haiku should handle this adequately. Can revisit if quality is poor.
- **Newsletter module consolidation**: Keep all newsletter-related code in `src/newsletter/` — extractor, sync, profile loader, corrections UI helper. Avoids thin top-level modules and naming collisions with `src/triage/corrections.ts`.
- **Processed emails tracking for newsletters**: Newsletter emails are still stored in `processed_emails` with a new `is_newsletter: true` column. The digest generator uses this flag to render the stats summary view for newsletters instead of the per-email summary view.

## Open Questions

### Resolved During Planning

- **Readwise API capabilities**: Fully supports tags, notes, location, saved_using. 50 saves/min rate limit is generous. No SDK needed — raw fetch.
- **What to do with insights that have no URL**: Save the newsletter's own "view in browser" URL to Readwise as a single item representing the whole newsletter.
- **Where the reader profile lives**: Local markdown file via `READER_PROFILE_PATH` env var, re-read on each poll cycle.
- **Topic tag taxonomy**: Semi-constrained — LLM picks from topics defined in the reader profile.
- **Web UI auth**: Token-based access via unique URLs embedded in digest emails. Tokens expire after a configurable period.
- **Error handling for Readwise failures**: Store with pending status, retry with exponential backoff (max 10), then abandon. Surface in digest.
- **Module structure**: All newsletter code in `src/newsletter/` (not separate corrections/profile modules). Matches codebase convention of substantive modules.
- **Digest/newsletter interaction**: `is_newsletter` column in `processed_emails` tells the digest generator to render stats view vs per-email summary.
- **Folder corrections and newsletters**: `CorrectionProcessor` skips newsletters — they're managed via the web UI.

### Deferred to Implementation

- **Exact confidence threshold for "uncertain" items in digest**: Start with 0.6, tune based on observed distribution.
- **Exact confidence threshold for newsletter detection gate**: Start with 0.7, tune based on false positive rate.
- **Optimal prompt structure for combined extraction + tier classification**: May be one LLM call or two. Try single-pass first (extract links and assign tiers in one prompt with reader profile context), split if quality suffers.
- **Newsletter "view in browser" URL extraction**: Need to investigate how reliably these URLs appear in newsletter HTML.
- **Shared link extraction refactoring**: Whether to move `extractLinksWithLLM` to `link-extractor.ts` or create a new shared utility. Depends on how much the newsletter extraction prompt diverges from the digest extraction prompt.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
                    ┌──────────────┐
                    │  Inbox Poll  │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  Classify    │  (adds isNewsletter + confidence)
                    │  (existing)  │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │ isNewsletter             │ !isNewsletter
              │ (confidence > gate)      │ (or below gate)
              ▼                          ▼
    ┌─────────────────┐       ┌──────────────────┐
    │ Newsletter       │       │ Operational Email │
    │ Pipeline (new)   │       │ Pipeline (as-is)  │
    └────────┬────────┘       └──────────────────┘
             │
    ┌────────▼────────┐
    │ Fetch full body │  (eager getEmailBody call)
    └────────┬────────┘
             │
    ┌────────▼────────┐
    │ Extract Items   │  (reuse link-extractor + LLM)
    │ + Classify Tiers│  (reader profile as context)
    └────────┬────────┘
             │
     ┌───────┼───────┐
     │ must  │ nice  │ skip
     │ read  │ have  │
     ▼       ▼       │
  ┌────────────┐     │
  │ Save to    │     │
  │ Readwise   │     │
  │ (new/later)│     │
  └────────────┘     │
             ┌───────┘
             ▼
    ┌─────────────────┐
    │ Store in DB     │  (all items + is_newsletter in processed_emails)
    │ Archive email   │
    └─────────────────┘

  ┌─────────────────────────────────────────┐
  │ Retry loop (each poll cycle):           │
  │ - Query failed/pending items            │
  │ - Exponential backoff (max 10 retries)  │
  │ - Transition to saved or abandoned      │
  └─────────────────────────────────────────┘

  ┌─────────────────────────────────────────┐
  │ Digest (at scheduled times):            │
  │ - Newsletter stats (from newsletter_    │
  │   items + is_newsletter flag)           │
  │ - Uncertain items for review            │
  │ - Correction UI link                    │
  │ - Operational email summaries (as-is)   │
  └─────────────────────────────────────────┘
```

## Implementation Units

**Ordering constraint:** Units 7 and 9 must ship together. If the triage engine starts routing newsletters through the new pipeline (Unit 7) before the digest is reworked (Unit 9), the digest generator will attempt to summarize already-archived newsletters whose bodies are no longer fetchable.

- [ ] **Unit 1: Readwise client module**

**Goal:** Create a thin Readwise Reader API client for saving URLs with tags/metadata.

**Requirements:** R4

**Dependencies:** None

**Files:**
- Create: `src/readwise/client.ts`
- Create: `src/readwise/types.ts`
- Create: `src/readwise/index.ts`

**Approach:**
- Thin wrapper around `fetch` to `POST /api/v3/save/` and `PATCH /api/v3/update/<id>/`
- Token auth from `READWISE_TOKEN` env var
- Handle 429 rate limiting with Retry-After header
- Handle 200 (already exists) vs 201 (created) responses
- Return document ID for DB storage
- On PATCH, verify `saved_using: "fastermail"` before modifying to avoid touching user-saved docs

**Patterns to follow:**
- `src/jmap/client.ts` for client class structure and error handling
- Project's existing approach of no external HTTP dependencies (raw fetch)

**Test scenarios:**
- Successful save returns document ID
- Rate-limited request retries after Retry-After delay
- Already-existing URL returns 200 with existing document ID
- Auth failure throws descriptive error
- Network failure throws without crashing the process

**Verification:**
- Can save a URL to Readwise Reader and retrieve the document ID
- Rate limiting is handled gracefully

---

- [ ] **Unit 2: Reader profile loader**

**Goal:** Load and parse the user's reader profile markdown file for use in relevance scoring prompts.

**Requirements:** R6, R7

**Dependencies:** None

**Files:**
- Create: `src/newsletter/profile.ts`

**Approach:**
- Read markdown file from path specified in `READER_PROFILE_PATH` env var
- Parse into structured sections: role, focus areas, core interests, adjacent interests, low-value topics, decision-making context
- Re-read on each poll cycle (file mtime check to avoid unnecessary re-reads)
- Extract topic vocabulary from focus areas + interests for semi-constrained topic tagging
- Types for the parsed profile defined in the same file (small enough to not need a separate types file)

**Patterns to follow:**
- Environment variable configuration pattern used throughout the project
- Simple file I/O with error handling

**Test scenarios:**
- Valid profile file parses into structured sections
- Missing file path env var produces clear error at startup
- File not found produces descriptive error
- Malformed markdown still extracts what it can
- File mtime check prevents unnecessary re-reads

**Verification:**
- Reader profile is loaded and its sections are accessible for prompt construction
- Topic vocabulary extracted for use in classification prompts

---

- [ ] **Unit 3: Enhanced newsletter detection**

**Goal:** Extend the classifier to reliably distinguish newsletters from operational emails, with a confidence gate to prevent false-positive archiving.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `src/triage/classifier.ts`

**Approach:**
- Add `isNewsletter: boolean` and `newsletterConfidence: number` to classifier output (alongside existing `contentFormat`)
- Enhance classification prompt with explicit newsletter detection signals: List-Unsubscribe header presence, noreply/newsletter sender domains, bulk email indicators, content format (link_collection, article)
- The existing `contentFormat` already catches many newsletters but misses some essay-style ones
- Parse `isNewsletter` and `newsletterConfidence` from LLM response alongside existing fields
- Emails with `isNewsletter: true` but confidence below gate threshold (start with 0.7) fall through to operational path and are surfaced in digest as "possible newsletters"

**Patterns to follow:**
- Existing classifier prompt structure and output parsing in `classifier.ts`
- Content format detection approach (lines 135-141)

**Test scenarios:**
- Link roundup newsletter correctly identified (already detected via contentFormat)
- Essay-style newsletter from Substack correctly identified
- Transactional email from a company not misidentified as newsletter
- Personal email from someone at a company domain not misidentified
- Marketing blast vs. newsletter distinction (marketing = operational, newsletter = intelligence pipeline)
- Low-confidence newsletter detection falls through to operational path

**Verification:**
- Classifier output includes `isNewsletter` and `newsletterConfidence` fields
- High-confidence newsletters route to the new pipeline
- Low-confidence newsletters handled as operational email and flagged in digest

---

- [ ] **Unit 4: Newsletter items database schema**

**Goal:** Add database tables for extracted newsletter items, Readwise sync state, tier corrections, and correction tokens. Add `is_newsletter` column to `processed_emails`.

**Requirements:** R2, R4, R8, R9, R10

**Dependencies:** None

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/store.ts`

**Approach:**
- New `newsletter_items` table: id, email_id, url, title, description, tier (must-read/nice-to-have/skip), topic_tag, confidence, reason (LLM explanation), readwise_status (pending/saved/failed/abandoned), readwise_doc_id, retry_count, next_retry_after, created_at
- New `tier_corrections` table: id, item_id, original_tier, corrected_tier, created_at
- New `correction_tokens` table: id, token, digest_id, created_at, expires_at
- Add `is_newsletter` column to `processed_emails` (ALTER TABLE with try/catch, default false)
- Add Store methods: newsletter item CRUD, items by readwise_status, items by digest_id, correction queries, pending retry queries, correction token validation
- DB row types (`NewsletterItem`, `TierCorrection`, `CorrectionToken`) defined in `store.ts` following existing convention

**Patterns to follow:**
- Existing `processed_emails` and `corrections` table structure in `schema.ts`
- Store class method pattern in `store.ts` (raw SQL, parameterized, manual row mapping)
- Try/catch ALTER TABLE migration pattern for adding `is_newsletter` column

**Test scenarios:**
- Newsletter items stored and retrieved by email_id
- Items queried by readwise_status for retry logic
- Items queried with retry_count < 10 and next_retry_after < now for backoff
- Tier corrections stored and retrievable for few-shot examples
- Correction tokens validated and expired correctly
- `is_newsletter` column works for existing and new emails

**Verification:**
- Schema creates cleanly on fresh database
- Schema migrates cleanly on existing database
- All CRUD operations work correctly

---

- [ ] **Unit 5: Newsletter extraction and tier classification**

**Goal:** Extract links/insights from newsletters and classify each item by relevance tier using the reader profile.

**Requirements:** R2, R3, R7

**Dependencies:** Unit 2 (reader profile), Unit 4 (database schema)

**Files:**
- Create: `src/newsletter/extractor.ts`
- Create: `src/newsletter/index.ts`
- Modify: `src/digest/link-extractor.ts` or `src/digest/strategies.ts` (extract shared link extraction logic for reuse)
- Modify: `src/digest/index.ts` (update barrel exports if strategies.ts exports change)

**Approach:**
- Reuse the existing two-phase extraction: regex link extraction from HTML (`link-extractor.ts`) then LLM refinement
- Extend the LLM prompt to include reader profile context and output tier classification per link
- Single LLM call that extracts + classifies in one pass: for each link output `{url, title, description, tier, topic, confidence, reason}`
- For essay newsletters with no external links, extract the newsletter's "view in browser" URL as a single item
- Use existing URL redirect resolution (`resolveRedirectUrls`) to clean URLs before classification
- The shared link extraction logic (regex filtering, URL normalization) may need to be refactored out of `strategies.ts` into `link-extractor.ts` — decide during implementation based on how much the newsletter prompt diverges from the digest prompt

**Patterns to follow:**
- `extractLinksWithLLM` in `src/digest/strategies.ts` for LLM JSON output parsing
- Batch concurrency pattern from `classifier.ts`

**Test scenarios:**
- Link roundup newsletter produces multiple items with varied tiers
- Essay newsletter with no links produces a single item (the newsletter itself)
- Reader profile influences tier assignment (work-relevant link gets must-read, tangential gets nice-to-have)
- Low-value topic from profile gets skip classification
- Malformed HTML still extracts what it can
- Newsletter with only navigation/footer links produces no items (all filtered)

**Verification:**
- Extracted items have URLs, titles, tiers, topics, and confidence scores
- Tier distribution reflects reader profile priorities

---

- [ ] **Unit 6: Readwise save pipeline**

**Goal:** Save classified newsletter items to Readwise Reader with appropriate tags and metadata, with retry logic and backoff.

**Requirements:** R4

**Dependencies:** Unit 1 (Readwise client), Unit 4 (database schema), Unit 5 (extraction)

**Files:**
- Create: `src/newsletter/sync.ts`

**Approach:**
- For each must-read and nice-to-have item: call Readwise save API
- Tag structure: `["tier:must-read", "src:<newsletter-slug>", "topic:<topic>"]`
- Must-read items: `location: "new"`, nice-to-have: `location: "later"`
- Include `saved_using: "fastermail"` and `notes: <LLM reason for saving>`
- Store `readwise_doc_id` in DB on success, set `readwise_status: "saved"`
- On API failure: set `readwise_status: "failed"`, increment retry_count, set next_retry_after with exponential backoff
- After 10 failures: set `readwise_status: "abandoned"`
- Skip-tier items: set `readwise_status` to null (never attempted)
- This module is a thin "save these items and report results" layer — retry orchestration (when to call it) lives in the engine

**Patterns to follow:**
- Error handling pattern from `classifier.ts` (try/catch per item, continue on failure)
- Batch processing pattern from `classifyBatch`

**Test scenarios:**
- Items saved to Readwise with correct tags and location
- Failed save marked in DB with incremented retry count and backoff time
- Already-existing URL (200 response) handled gracefully — store the existing doc_id
- Rate-limited request retried after delay
- Skip-tier items not sent to Readwise
- After 10 failures, item transitions to abandoned
- Exponential backoff correctly calculates next retry time

**Verification:**
- Must-read and nice-to-have items appear in Readwise with correct tags
- Failed saves are retried with proper backoff
- Skip items never touch Readwise
- Abandoned items stop retrying

---

- [ ] **Unit 7: Newsletter pipeline orchestration in triage engine**

**Goal:** Wire the newsletter pipeline into the existing triage engine poll loop.

**Requirements:** R1, R5, R12, R13

**Dependencies:** Unit 3 (detection), Unit 5 (extraction), Unit 6 (Readwise sync)

**Must ship with:** Unit 9 (digest rework) — otherwise the digest will attempt to summarize archived newsletters whose bodies are no longer fetchable.

**Files:**
- Modify: `src/triage/engine.ts`
- Modify: `src/triage/corrections.ts` (skip newsletters in folder-based correction processing)
- Modify: `src/index.ts` (bootstrap new modules)

**Approach:**
- After classification, branch on `isNewsletter` AND `newsletterConfidence > gate`:
  - Newsletter → **eagerly fetch full body via `getEmailBody()`** → extract items → classify tiers → save to Readwise → store items in DB → mark `is_newsletter: true` in processed_emails → archive email
  - Not newsletter (or below confidence gate) → existing operational email flow (unchanged)
- This changes the data-fetching contract: newsletters need body during triage, not deferred to digest. Extract a `processNewsletterEmail` method to keep `processEmail` clean.
- Retry pending/failed Readwise saves at the start of each poll cycle (alongside existing correction processing): query items where `readwise_status = 'failed'` AND `retry_count < 10` AND `next_retry_after < now()`
- In `CorrectionProcessor.scanForCorrections`, skip emails where `is_newsletter: true` in processed_emails — newsletter corrections happen via web UI, not folder moves
- Load reader profile at engine initialization, reload on each cycle via mtime check
- Add `READWISE_TOKEN` and `READER_PROFILE_PATH` to startup validation

**Patterns to follow:**
- Existing `processNewEmails` flow in `engine.ts`
- The existing pattern of processing corrections before new emails
- Flat orchestration: engine owns all scheduling and retry decisions

**Test scenarios:**
- Newsletter email goes through extraction + Readwise pipeline, gets archived
- Operational email follows existing classification + labeling flow (unchanged)
- Low-confidence newsletter treated as operational email
- Readwise API down: newsletter still archived, items stored as pending, retried next cycle
- Missing reader profile: clear error message at startup
- Folder-based correction processor skips newsletters
- Retry loop processes only eligible failed items (within retry budget and past backoff window)

**Verification:**
- Newsletters are extracted, items saved to Readwise, emails archived
- Operational emails handled exactly as before
- Failed Readwise saves retried on subsequent cycles with backoff
- No regression in existing triage behavior

---

- [ ] **Unit 8: Correction web UI**

**Goal:** Build a simple web UI for reviewing and reclassifying newsletter items.

**Requirements:** R8, R9

**Dependencies:** Unit 4 (database schema), Unit 1 (Readwise client)

**Files:**
- Create: `src/newsletter/corrections-ui.ts` (HTML generation helper)
- Modify: `src/index.ts` (add routes)
- Modify: `src/db/store.ts` (correction token validation if not already in Unit 4)

**Approach:**
- New endpoint: `GET /corrections?token=<token>` — renders page showing recent newsletter items with tiers
- Items grouped by newsletter, showing: title, URL, current tier, source, topic, confidence
- Each item has tier selector (must-read / nice-to-have / skip) that submits via `GET /corrections/update?token=<token>&item=<id>&tier=<new-tier>`
- On reclassification: store tier correction in DB, if promoted to must-read/nice-to-have trigger retroactive Readwise save via sync module
- On demotion: update Readwise tags via PATCH (only if `saved_using: "fastermail"` — guard against modifying user-saved docs), do NOT delete from Readwise
- Token-based access: generated per digest, stored in `correction_tokens` table, expires after configurable period (default 7 days)
- HTML generation extracted to `src/newsletter/corrections-ui.ts`, routing and request handling stays in `src/index.ts`

**Patterns to follow:**
- Existing `/cleanup` and `/email-action` endpoint patterns in `index.ts`
- Inline HTML template strings with inline styles
- Token-based access pattern from cleanup tokens

**Test scenarios:**
- Valid token renders correction page with recent items
- Expired token shows friendly error
- Invalid token shows friendly error
- Reclassifying a skip to must-read saves it to Readwise retroactively
- Reclassifying a must-read to skip updates Readwise tags (does not delete)
- Corrections stored in DB for few-shot learning

**Verification:**
- Correction UI accessible from digest link
- Items can be reclassified with immediate effect
- Retroactive Readwise saves work on promotion

---

- [ ] **Unit 9: Digest rework**

**Goal:** Transform the digest from a reading task into a brief status report for newsletters while preserving operational email summaries.

**Requirements:** R10, R11

**Dependencies:** Unit 4 (database schema), Unit 8 (correction UI for link generation)

**Must ship with:** Unit 7 (orchestration) — see ordering constraint above.

**Files:**
- Modify: `src/digest/generator.ts`
- Modify: `src/digest/strategies.ts` (existing `link_collection` and `article` strategies become partially dead code for newsletters — clean up or gate on `is_newsletter`)

**Approach:**
- The digest generator queries `processed_emails` by digest_id as before. It now checks `is_newsletter`:
  - `is_newsletter = true` → render as stats summary: X newsletters processed, Y items extracted, Z sent to Readwise (N must-read, M nice-to-have), any failures or abandoned items
  - `is_newsletter = false` → render with existing per-email summary strategies (unchanged)
- Include uncertain items (confidence < 0.6) with their titles and assigned tiers for quick review
- Include low-confidence newsletter detections (treated as operational) for user awareness
- Include correction web UI link (generate token, build URL)
- Keep existing cleanup button for operational emails
- The existing `applyLinkCollectionStrategy` and `applyArticleStrategy` in `strategies.ts` may still be needed for non-newsletter emails with those content formats (e.g., a colleague forwarding a link roundup). Gate these strategies on `is_newsletter` rather than removing them.

**Patterns to follow:**
- Existing digest HTML generation in `generator.ts`
- Existing grouping and summary patterns

**Test scenarios:**
- Digest shows correct newsletter processing stats
- Uncertain items listed with tier and source
- Low-confidence newsletter detections flagged for review
- Correction UI link works with valid token
- Operational emails still summarized as before (no regression)
- Digest with zero newsletters processed shows clean "no newsletters" state
- Digest with Readwise failures shows "X items failed to save" warning
- Digest with abandoned items shows permanent failure notice
- Non-newsletter emails with link_collection format still get per-email summaries

**Verification:**
- Digest email is a quick status check, not a reading task
- All stats accurate relative to database records
- Correction link works
- Operational email summaries unchanged

---

- [ ] **Unit 10: Few-shot learning from tier corrections**

**Goal:** Feed tier corrections back into the extraction/classification prompt as few-shot examples.

**Requirements:** R9

**Dependencies:** Unit 4 (database schema), Unit 5 (extraction), Unit 8 (correction UI)

**Files:**
- Modify: `src/newsletter/extractor.ts`
- Modify: `src/db/store.ts` (query recent corrections)

**Approach:**
- Query recent tier corrections (last 10-20) from the DB
- Summarize into examples: "Link about X from Y newsletter was classified as skip but should be must-read because..."
- Include these summaries in the extraction/classification LLM prompt as context
- Follows the same pattern as existing email-level corrections in `buildConfigFromStore`

**Patterns to follow:**
- `buildConfigFromStore` in `src/triage/rules.ts` — the existing correction-to-few-shot pipeline

**Test scenarios:**
- Recent corrections included in extraction prompt
- Corrections from different newsletters generalize (not just same-source)
- No corrections yet: prompt works without examples
- Old corrections eventually aged out

**Verification:**
- Classification quality improves after corrections
- Few-shot examples appear in LLM prompt context

## System-Wide Impact

- **Interaction graph:** The triage engine (`engine.ts`) gains a newsletter branch with eager body fetching. The digest generator checks `is_newsletter` to switch between stats and per-email views. New HTTP routes in `index.ts`. New Readwise API calls during poll cycles. Reader profile file read on each cycle. `CorrectionProcessor` gains a newsletter skip filter.
- **Error propagation:** Readwise API failures must not block email processing. Items stored as pending, retried with exponential backoff up to 10 times, then abandoned. Digest surfaces failures and abandoned items. LLM extraction failures fall back to treating the newsletter like a regular email (existing classification flow with `is_newsletter: false`).
- **State lifecycle risks:** Newsletter items can be in pending → saved, pending → failed → saved (retry), or pending → failed → abandoned states. Retry budget (10 max) and exponential backoff prevent unbounded accumulation. Duplicate Readwise saves are idempotent (returns 200 with existing doc_id). Corrections after Readwise save use PATCH with `saved_using` guard. Items stuck in pending because they were never attempted (extraction succeeded, save not yet called) are distinct from failed items — initial state is "pending", first attempt transitions to "saved" or "failed".
- **Content format strategy interaction:** The existing `applyLinkCollectionStrategy` and `applyArticleStrategy` in `strategies.ts` remain for non-newsletter emails. Newsletter emails (where `is_newsletter: true`) bypass these strategies entirely — the digest renders stats for them. Non-newsletter emails with `link_collection` or `article` content format still get per-email summaries.
- **API surface parity:** The existing `/cleanup` and `/email-action` endpoints remain unchanged. New `/corrections` and `/corrections/update` endpoints follow the same pattern.
- **Integration coverage:** End-to-end flow from email arrival through Readwise save. Correction flow from digest link through web UI through Readwise update. Retry flow from failed save through backoff through eventual success or abandonment. Digest flow distinguishing newsletter stats from operational summaries.

## Risks & Dependencies

- **Readwise API availability**: Core dependency for the new pipeline. Mitigated by retry logic with exponential backoff and pending/abandoned state tracking. If Readwise is down for extended periods, items accumulate up to 10 retries then get abandoned with a digest warning.
- **Newsletter detection false positives**: An important email misidentified as newsletter gets archived without attention. Mitigated by confidence gate (below threshold → operational path), surfacing uncertain detections in digest, and conservative heuristics. This is the single most dangerous failure mode.
- **Reader profile quality**: Garbage in, garbage out. If the profile is vague, tier classification will be poor. Mitigated by the structured extraction prompt we generated for the user's other Claude chatbot.
- **LLM cost increase**: Each newsletter now gets an additional extraction + classification call beyond the initial classification. Haiku is cheap but volume matters. Monitor API costs.
- **HTTP server complexity growth**: `src/index.ts` is already 180+ lines. Adding correction routes pushes it further. Mitigated by extracting HTML generation to `src/newsletter/corrections-ui.ts`. Note as follow-up: consider extracting route handlers if the file exceeds ~300 lines.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-03-30-newsletter-intelligence-requirements.md](docs/brainstorms/2026-03-30-newsletter-intelligence-requirements.md)
- **Readwise Reader API:** https://readwise.io/reader_api — save endpoint, tag support, location field, rate limits
- Related code: `src/digest/strategies.ts` (link extraction), `src/triage/classifier.ts` (classification), `src/triage/corrections.ts` (correction pattern), `src/triage/rules.ts` (few-shot pipeline), `src/digest/link-extractor.ts` (shared link extraction)
