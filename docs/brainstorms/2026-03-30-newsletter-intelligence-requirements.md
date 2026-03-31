---
date: 2026-03-30
topic: newsletter-intelligence
---

# Newsletter Intelligence: Reduce Overwhelm, Stay Up to Date

## Problem Frame

The current Fastermail system classifies all emails into 4 priority buckets and sends digest summaries. But the real problem is newsletters: they're the bulk of incoming email, they contain valuable signal buried in noise, and classifying them as "low-priority" or "fyi" doesn't reduce the reading burden — it just moves it.

The user subscribes to many newsletters they value, but:
- Some have poor signal-to-noise ratio
- Some aren't immediately relevant despite being interesting
- The current digest still requires heavy triaging to find what matters
- Newsletters clutter the email account even after processing

**Core goal:** Extract the signal from newsletters, route it to where the user actually reads (Readwise), and get newsletters out of email entirely — so email is for operational messages and Readwise is for curated reading.

## Requirements

### Newsletter Processing

- R1. The agent identifies which incoming emails are newsletters (vs. operational email)
- R2. For each newsletter, the agent reads the full content and extracts individual links/insights/items
- R3. Each extracted item is classified into one of three tiers based on a user-provided reader profile:
  - **Must-read**: directly relevant to the user's current work and focus areas
  - **Nice-to-have**: interesting, curious, adjacent to interests but not urgent
  - **Skip**: not relevant right now
- R4. Must-read and nice-to-have items are saved to Readwise Reader via their API, tagged with: tier (must-read / nice-to-have), source newsletter name, and an agent-assigned topic tag
- R5. After processing, the newsletter email is archived out of the inbox

### Reader Profile

- R6. The agent uses a user-provided reader profile (markdown file) that describes: role, current focus areas, core interests, adjacent interests, low-value topics, and decision-making context
- R7. The reader profile is the primary input for relevance scoring — no cold-start learning period required

### Correction & Learning

- R8. A simple web UI shows recently extracted items with their assigned tier, allowing the user to reclassify items (e.g., promote a "skip" to "must-read" or demote a "must-read" to "skip")
- R9. Corrections are stored and used as few-shot examples to improve future classification (similar to the existing correction system)

### Digest Rework

- R10. The daily digest becomes a brief status report, not a reading task:
  - How many newsletters processed
  - How many items sent to Readwise (by tier)
  - Any items the agent was uncertain about (low confidence)
  - Link to the correction web UI
- R11. The digest still includes operational email summaries as it does today

### Operational Email (Unchanged)

- R12. Important and needs-reply emails remain in inbox with current handling
- R13. Non-newsletter fyi/low-priority emails are handled as today

## Success Criteria

- The user's inbox contains only operational emails that need attention
- Newsletter value is captured in Readwise without the user reading emails
- The user spends less time triaging and feels less overwhelmed
- The correction UI is fast enough that providing feedback takes seconds, not minutes

## Scope Boundaries

- **Not changing**: operational email classification, JMAP integration, polling loop, cleanup system
- **Not building**: auto-reply, auto-unsubscribe, newsletter recommendation engine
- **Not solving**: Readwise reading habits (that's the user's workflow to manage)
- **Deferred**: automatic profile updates from behavior (start with static profile + corrections)

## Key Decisions

- **Readwise as the destination**: User is an active Readwise Reader user; this is where they actually read long-form content. Routing there reduces context-switching vs. building a custom reading UI.
- **Three-tier classification (must/nice/skip)**: Simpler than the current 4-bucket system. "Must-read" and "nice-to-have" both get saved to Readwise but with different tags, letting the user prioritize in Readwise's own UI.
- **Static profile + corrections over behavioral learning**: Faster to ship, no cold-start problem, user maintains explicit control. Behavioral learning can be added later if corrections alone aren't enough.
- **Web UI for corrections**: More flexible than email-based corrections; allows quick batch review.

## Dependencies / Assumptions

- Readwise Reader API is available and supports saving URLs with tags/metadata
- User will provide an initial reader profile via a markdown file
- Existing newsletter detection (content_format: link_collection, sender analysis) can be extended for reliable newsletter identification

## Outstanding Questions

### Resolve Before Planning

(None — all blocking questions resolved)

### Deferred to Planning

- [Affects R1][Needs research] What's the best heuristic for reliably distinguishing newsletters from operational email? Current system uses sender patterns and content_format — may need improvement.
- [Affects R2][Technical] Should the agent extract individual article links, key quotes/insights, or full article text for Readwise? Readwise Reader API capabilities will determine this.
- [Affects R4][Needs research] Readwise Reader API: what are the rate limits, supported metadata fields, and tagging capabilities?
- [Affects R3][Technical] Should classification use the existing Haiku model or would a more capable model improve relevance scoring quality enough to justify the cost?
- [Affects R8][Technical] Should the correction web UI be a new page on the existing HTTP server, or a separate lightweight frontend?

## Next Steps

→ `/ce:plan` for structured implementation planning
