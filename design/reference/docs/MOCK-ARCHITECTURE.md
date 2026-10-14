# Mock architecture / polish boundary

The existing strict TypeScript service, versioned fixtures/commands, simulated idempotency, project persistence and public projections are retained. Tests compare command/quote/guard/financial/final/editor function implementations byte-for-byte against the Phase6D runtime; they are unchanged. Production gates remain literal false.

Presentation polish is src/polish.js and src/polish.css extending the copied controller. Customer view excludes repeated fixture IDs/time metadata; review mode adds one inspector with customer-safe public projection, never internal provider execution or vendor billing. Toggle changes no financial/entitlement state.

Data curation changes only direction presentation strings and Studio art paths; stable IDs, slot mapping, version parentage and original asset/private/mockup/print separation remain. No production reference type was modified. mock/proposals/director-plan-projection.ts is a compile-checked isolated proposal, not runtime code.

Offline build uses the preserved Node TypeScript erasure step; strict compilation is separately executed. Review/build/contract tests need no npm runtime dependencies or live service. Browser replay requires test-only tools and includes its own old runtime comparator.

Limitations remain: browser-local single-project data, synthetic identities/quotes/qualifications/rights, no ACID ledger, backend authorization, live provider/payment/Medusa/R2/print, or cryptographic scopes.
