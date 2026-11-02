# M1b legacy consumer regression coverage

2026-10-19, Asia/Dhaka. Owner-projected metadata received. The owner confirmed the development connection and volunteered as test executor. Per-consumer test locations, responsibility and runtime results remain pending. No client registration or settings changed.

[Inventory receipt](evidence/M1b-Legacy-Client-Inventory-20261019.json) preserves all client IDs and scopes. Source at Portal 35a47c9d resolves missing allowedGrants to authorization_code + refresh_token. Do not backfill those records as part of M1b. Two Publer registrations remain separate by client ID.

| Client | Client ID | Grant class | Baseline | Post-change |
|---|---|---|---|---|
| Social Riddle | `tcm_35acacfeba44f9ff7443cea9f57e19a9` | Interactive: legacy fallback | NOT_RUN | NOT_RUN |
| Charades Collective | `tcm_cd21080b0307695037a1186f0cf032ca` | Interactive: legacy fallback | NOT_RUN | NOT_RUN |
| Stream Elements | `tcm_70d58c063b1f4e97d8a618df44cc2a7f` | Interactive: legacy fallback | NOT_RUN | NOT_RUN |
| Printing | `tcm_0831871c0735d0d45121da851f4b624d` | Interactive: legacy fallback | NOT_RUN | NOT_RUN |
| DiscordManager | `tcm_6ddb70472d9554272208239542c36cd2` | Interactive: legacy fallback | NOT_RUN | NOT_RUN |
| Publer | `tcm_082cae7741ae2ac322c8eafb870839f5` | Interactive: legacy fallback | NOT_RUN | NOT_RUN |
| Publer | `tcm_471a473c4cb73be6bd583bb73a45e887` | Interactive: legacy fallback | NOT_RUN | NOT_RUN |
| StockChecker | `tcm_be01fe57314d0c17c176779004c9cd31` | Interactive: legacy fallback | NOT_RUN | NOT_RUN |
| Test2 | `tcm_4982f6db5b168f2f53da23078f301101` | Interactive: explicit | NOT_RUN | NOT_RUN |
| Giveaways | `tcm_8a4f2ee56492469bff0812d49d2a6022` | Interactive: legacy fallback | NOT_RUN | NOT_RUN |
| My TCM Login Test | `tcm_390446c6131b344f9165198da6909d41` | Interactive: legacy fallback | NOT_RUN | NOT_RUN |
| Hub2 Login | `tcm_38c347da7395d78ca6240655d92eeabc` | Interactive: explicit | NOT_RUN | NOT_RUN |
| Embed Iframe | `tcm_d431e92f8f10b5412183b7c78e95913e` | Interactive: explicit | NOT_RUN | NOT_RUN |
| Giveaway City dev social connections | `tcm_ade6262347f85e0068daabe368f3b776` | Service: explicit | NOT_RUN | NOT_RUN |
| TCM chat bot listings | `tcm_5f78b5cde33bec116232478be63c6ae8` | Service: explicit | NOT_RUN | NOT_RUN |
| TCM chat bot escrow | `tcm_b327e56558863262e1a34500da268df6` | Service: explicit | NOT_RUN | NOT_RUN |
| TCM chat bot system | `tcm_e61b9ceb043a6b1d73c15673ec6b086c` | Service: explicit | NOT_RUN | NOT_RUN |
| TCM chat bot discord-bridge | `tcm_61a641982a8f4bd935a324ebcc5d075e` | Service: explicit | NOT_RUN | NOT_RUN |
| TCM chat bot giftcodes | `tcm_b7c6cca05fa5a18ba74368ac572e8c27` | Service: explicit | NOT_RUN | NOT_RUN |

Interactive checks: normal existing login/consent/callback, existing account identity and granted scopes, refresh, applicable revoke/logout behavior and continuity of a pre-existing session. Include embedded/browser behavior for clients actually using it; names alone are not implementation evidence. Use synthetic accounts and preserve private credentials.

Service checks: normal client-credentials authentication, expected audience/scope/principal, denial for wrong credentials/audience/scope and unchanged applicable token/revoke behavior. Use a safe read-only resource or synthetic harness. Do not exercise real messaging, trade, escrow, linked-user impersonation or provisioning writes merely to obtain a smoke result. Test transport and permissions without business side effects.

Each client still needs a responsible owner, verified test location and sanitized baseline evidence before a rollout can be proposed as preserving that consumer. Source tests remain separate evidence. Registration presence does not prove a consumer is currently exercised or that all other consumers are absent.

Missing allowedGrants fallback, explicit interactive grants and explicit service grants must each be covered. Preserve both Publer client IDs. No scopes, providers, callback URLs, client secrets or grant records may be changed to make a test pass.

All rollout/publication/registration/storage/configuration actions remain separately gated. M1b remains incomplete.

Source verification: the grant resolver is unchanged between baseline e54028d0 and merged source 35a47c9d (successful exact Git comparison). The actual merged helper resolved all 19 projected registrations and passed 57 grant-membership checks on Node 22.23.3 without mutating inputs. This check uses no database, client credentials or HTTP requests and is not deployed consumer acceptance. Existing source tests explicitly cover absent allowedGrants fallback, service-only policy, exact grant sets and allowlist enforcement. Runtime coverage above remains NOT_RUN.

Owner execution: follow the [development baseline checklist](M1b-Owner-Legacy-Smoke-Checklist-20261019.md). Environment binding is owner-confirmed; no independent connection inspection was performed. Volunteering as test executor does not establish ownership or live results for every client.
