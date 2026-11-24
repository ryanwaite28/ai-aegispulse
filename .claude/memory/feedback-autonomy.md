---
name: feedback-autonomy
description: "Proceed autonomously through implementation, testing and troubleshooting; only stop when truly blocked"
metadata:
  node_type: memory
  type: feedback
  originSessionId: adaa8ab5-bb68-4808-ba71-9612d074e0aa
  modified: 2026-11-24T16:07:10.563Z
---

On 2026-11-24 the user said: when doing implementation, testing and troubleshooting, proceed with confidence using the project's skills and steering docs. Only ask for manual intervention when blocked, or when a question has no clear or intuitive answer.

**Why:** the user wants fewer check-ins. Phases had been pausing for confirmations whose answer was obvious from PROJECT.md, the steering docs or the skills.

**How to apply:**
- Choose the conventional or recommended option yourself, record it (spec, evidence, CHANGELOG), and keep going. Small clarification amendments that an FR forces count too.
- Run the local verification commands yourself (make migrate, compose build/up, make test-e2e, make trigger, demos), even when they read `.env` through the scripts. Only hand a step to the user if the permission system actually denies it (said 2026-11-24: "if you are able to perform these checks, perform them autonomously"). Never read or print `.env` contents directly.
- Still stop for 🛑 MANUAL steps ([[feedback-manual-steps-stop]]), anything that needs `.env` secrets the classifier blocks (hand it to the user), real product or scope decisions, and destructive or prod actions.
- Commit and push still require the user's go-ahead. Phase-boundary commits are fine once the user has said "commit and push, then continue".
- Related: [[feedback-phased-delivery]].
