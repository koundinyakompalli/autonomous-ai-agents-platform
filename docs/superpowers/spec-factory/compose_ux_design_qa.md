# Spec Factory Compose UX Design QA

## Design contract

- Keep the conversation as the primary workspace.
- Replace the full-width navigation with a compact icon rail.
- Separate uploaded sources from generated artifacts.
- Show live Sources, Requirements, Research, and Draft agent presence.
- Present requirement readiness as a structured brief rather than a long status sidebar.
- Use product-facing language such as "Thinking" and "Drafting".
- Support clipboard text and image/PDF ingestion as a first-class source action.
- Preserve business and functional clarification behavior while keeping implementation decisions out of user prompts.

## Visual verification

The redesigned Compose workspace was verified with a real, read-only session loaded through the local RDS tunnel.

| Viewport | Result | Coverage |
| --- | --- | --- |
| 1680 x 934 | Pass | Reference-matched product-discovery home and saved-session list/detail workspace |
| 1440 x 1024 | Pass | Three-column workspace, compact rail, source controls, agent presence, chat, and Requirements Brief |
| 1024 x 768 | Pass | Compact rail with Knowledge/Chat/Brief workspace switching |
| 390 x 844 | Pass | Scrollable home and saved-session flows plus chat-first workspace, mobile composer, Sources, Artifacts, and Brief |

## Regression checks

- No horizontal document overflow at the mobile breakpoint.
- All composer actions remain within the mobile viewport.
- Source search retains a stable 38px height despite legacy modal styles.
- The tablet navigation remains a vertical rail despite legacy responsive styles.
- Browser console verification reported zero errors and zero warnings.
- Persona images render from local static assets; no runtime image dependency is required.
- Session picker landing, create, resume, about, and upload states use dark text and a visible brand lockup on the light modal surface.
- Saved-session search, status/agent filters, sort, selection, pagination, resume, export, delete, and password prompts remain functional.
- The saved-session screen preserves real retention, source, decision, open-question, activity, password, context, and persona data instead of illustrative mock values.

## Final result

Passed.
