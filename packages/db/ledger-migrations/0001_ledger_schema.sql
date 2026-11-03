-- 0001_ledger_schema (ADR-0021, M7 S1). Creates the empty ledger schema ONLY: no tables, no grants, no functions.
-- Tables arrive in later, separately reviewed migrations (0002+). Additive; touches nothing in vynvori_identity.
CREATE SCHEMA vynvori_ledger;
