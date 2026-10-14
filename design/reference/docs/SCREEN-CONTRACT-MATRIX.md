# Screen contract and evidence matrix

Status IMPLEMENTED_LOCAL means an executed local mock, not production acceptance. Production for all rows remains NOT_IMPLEMENTED/BLOCKED. Routes below are modeled by the local # router.

| ID | Requirement / interactive view | Canonical route | Primary fixture | Evidence | Status |
|---|---|---|---|---|---|
| ST-00 | Equal guide/free entry and independent BYO | /studio | entry | exports/ST-00-entry.png; exports/contract-results.json; exports/browser-results.json | IMPLEMENTED_LOCAL |
| ST-01 | Seven-field visual wizard, validation, back/next, local draft | /studio/guide | guide-success | exports/ST-01-guide-success.png; exports/contract-results.json; exports/browser-results.json | IMPLEMENTED_LOCAL |
| ST-02 | Prompt/reference/restrictions, same CreativeBrief normalization | /studio/free | free-normalized | exports/ST-02-free-normalized.png; exports/contract-results.json; exports/browser-results.json | IMPLEMENTED_LOCAL |
| ST-03 | Review, simulated claim, expiry/conflict and private recovery | /studio/brief/draft-01 | claim-conflict | exports/ST-03-claim-conflict.png; exports/contract-results.json; exports/browser-results.json | IMPLEMENTED_LOCAL |
| ST-04 | Bounded nonbillable Director planning, no paid concept execution | /studio/projects/project-atelier-01 | director-planning | exports/ST-04-director-planning.png; exports/contract-results.json; exports/browser-results.json | IMPLEMENTED_LOCAL |
| ST-05 | Exactly three directions, whole-plan approval and frozen mapping | /studio/projects/project-atelier-01 | director-review | exports/ST-05-director-review.png; exports/contract-results.json; exports/browser-results.json | IMPLEMENTED_LOCAL |
| ST-06 | One extra free promotional preview, one chosen direction | /studio/projects/project-atelier-01 | promo-eligible | exports/ST-06-promo-eligible.png; exports/contract-results.json; exports/browser-results.json | IMPLEMENTED_LOCAL |
| ST-07 | Promo running/delivered/failed/unknown/used/unavailable, independent slot | /studio/projects/project-atelier-01 | promo-delivered | exports/ST-07-promo-delivered.png; exports/contract-results.json; exports/browser-results.json | IMPLEMENTED_LOCAL |
| ST-08 | 3+2 disclosures, quote guard, funds/holds, fresh consent after top-up | /studio/projects/project-atelier-01 | bundle-valid | exports/ST-08-bundle-valid.png; exports/contract-results.json; exports/browser-results.json | IMPLEMENTED_LOCAL |
| ST-09 | 0/3 pending operations, stable independent IDs | /studio/projects/project-atelier-01 | concepts-0 | exports/ST-09-concepts-0.png; exports/contract-results.json; exports/browser-results.json | IMPLEMENTED_LOCAL |
| ST-10 | 1/3 or 2/3 persisted view, uncertain/persistence failure and support | /studio/projects/project-atelier-01 | concept-unknown | exports/ST-10-concept-unknown.png; exports/contract-results.json; exports/browser-results.json | IMPLEMENTED_LOCAL |
| ST-11 | Three distinct immutable direction-linked artworks and explicit selection | /studio/projects/project-atelier-01 | concepts-3 | exports/ST-11-concepts-3.png; exports/contract-results.json; exports/browser-results.json | IMPLEMENTED_LOCAL |
| ST-12 | Slot1 source/change/preserve/typography, skip/restore, before/after | /studio/projects/project-atelier-01 | refinement-1 | exports/ST-12-refinement-1.png; exports/contract-results.json; exports/browser-results.json | IMPLEMENTED_LOCAL |
| ST-13 | Slot2 optional branch, pending/unknown locks, preserved history | /studio/projects/project-atelier-01 | refinement-2 | exports/ST-13-refinement-2.png; exports/contract-results.json; exports/browser-results.json | IMPLEMENTED_LOCAL |
| ST-14 | Separate Standard quote, closure disclosure, Premium unavailable | /studio/projects/project-atelier-01 | final-available | exports/ST-14-final-available.png; exports/contract-results.json; exports/browser-results.json | IMPLEMENTED_LOCAL |
| ST-15 | No qualified final / revoked capability, preservation and remedy case | /studio/projects/project-atelier-01 | final-revoked | exports/ST-15-final-revoked.png; exports/contract-results.json; exports/browser-results.json | IMPLEMENTED_LOCAL |
| ST-16 | Separate reservation/execution/persistence/settlement, Use/Save/new quote/quality | /studio/projects/project-atelier-01 | final-charge-review | exports/ST-16-final-charge-review.png; exports/contract-results.json; exports/browser-results.json | IMPLEMENTED_LOCAL |
| ST-17 | Brief/plan/version lineage, private save, eligible editor/export/gallery | /studio/projects/project-atelier-01/history | history | exports/ST-17-history.png; exports/contract-results.json; exports/browser-results.json | IMPLEMENTED_LOCAL |
| ED-01 | Guest upload/image/text entry without AI; BYO returns to storefront | /customize | byo-empty | exports/desktop-byo-empty.png; exports/browser-results.json | IMPLEMENTED_LOCAL |
| ED-02 | Front/back multilayer mm workspace, controls, lock/reorder, undo, save/version | /customize/composition-01 | byo-layers | exports/desktop-byo-layers.png; exports/browser-results.json | IMPLEMENTED_LOCAL |
| ED-03 | Frozen scene review, proof/mockup/master distinction, supplier and print gates | /customize/composition-01/review | composition-review | exports/desktop-composition-review.png; exports/browser-results.json | IMPLEMENTED_LOCAL |
| CO-01 | Frozen cart, size, expiry, region, quote inspection and unavailable checkout | /cart | cart | exports/desktop-cart.png; exports/browser-results.json | IMPLEMENTED_LOCAL |
| AC-01 | Owner projects, wallet, order/QA projection, exports/expired access and cases | /account/projects | account | exports/desktop-account.png; exports/browser-results.json | IMPLEMENTED_LOCAL |
| GA-01 | Owner opt-in, moderation states, unpublish, sanitized derivative only | /gallery | gallery-pending | exports/desktop-gallery-published.png; exports/browser-results.json | IMPLEMENTED_LOCAL |
| AD-01 | Separate illustrative human approval, release guard, material-edit reapproval | /admin/vynvori/qa | qa-hold | exports/desktop-qa-hold.png; exports/browser-results.json | IMPLEMENTED_LOCAL |

Boundaries / missing evidence: actual signed ownership, R2 manifests, server routes, quote signatures, central SSO, provider reconciliation, Medusa capture, supplier print QA and production API contracts are NOT_IMPLEMENTED. Manual assistive-tech reading and physical on-screen keyboard are NOT_TESTED. Premium remains BLOCKED; no qualified Premium fixture is claimed. Full DTF/export files are NOT_IMPLEMENTED; the owner can retrieve their unchanged local original and an illustrative entitled house-study export.

## Targeted polish overlays

ST08 and ST14: single-wallet purchase summaries and visible required terms; ST05 and ST11: curated differentiated artwork; ST12/13/ED02: traceable new art lineage; ST16: delivery/closure/credit/case clarity. See polish-browser-results.json and AFTER screenshots. Stage routes/IDs and all original connected-screen behavior are unchanged. The ST05 contract correction is PROPOSED, not applied. Phase6E means dual acceptance, not production implementation.
