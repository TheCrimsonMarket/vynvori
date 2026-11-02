# M1b owner-run development baseline smoke tests

2026-10-19, Asia/Dhaka. Owner confirmed the inventory connection belongs to Portal development and volunteered to run legacy smoke tests. This is a pre-change baseline on existing development consumers. It does not authorize deployment, new registrations, client setting changes or business operations.

## Interactive apps

Use an existing synthetic development account. Open the app through its normal development URL. Confirm its login leads to the intended development Portal; if the path instead uses production, stop that test and report BLOCKED. Do not change callback registrations to force a test.

1. In an existing signed-in synthetic session, confirm the app still recognizes the expected account. Keep that session for a later separately approved post-rollout continuity check; if it expires naturally, record that limitation.
2. In a separate browser profile/private window, sign in through the normal Portal flow. If consent is presented, confirm it returns to the same app and expected synthetic account without an error or redirect loop. Do not demand new consent when an existing grant legitimately skips it.
3. Reload a harmless account/profile view. Confirm the app remains signed in and shows the expected identity and existing permitted data. Do not create an order, message, trade or other business action.
4. If the app has an existing development test harness for refresh or scoped authorization, run its normal safe check and report its result. Successful reload alone does not prove refresh occurred; otherwise record refresh NOT_RUN.
5. In the disposable new session only, use normal logout and confirm its ordinary behavior. Record local logout separately from central token revocation; logout alone does not prove revocation. Do not revoke the retained continuity session.

Record the actual development URL, synthetic account match as yes/no (no email or account identifiers needed), login result, profile result, refresh evidence or NOT_RUN, disposable-session logout result, retained-session availability and nonsecret errors. Keep cookies/tokens and network exports private.

## Service clients

Use only an existing development harness or normal safe authentication diagnostic with credentials already stored privately. Check token issuance and applicable audience/scope/principal validation; share only outcomes, never token values or credentials. A safe read-only protected request may be used where one already exists. Do not invent an endpoint or invoke real message, escrow, trade, bridge impersonation, conversation creation, giftcode or social-connection writes. If there is no safe harness/resource, mark BLOCKED and describe what is missing. Do not rotate secrets or modify clients. Negative permission checks must use a synthetic harness where an unexpected success cannot cause a real business mutation.

## Results sheet

Every cell starts NOT_RUN. Use PASS, FAIL, BLOCKED or NOT_RUN per check; do not collapse untested refresh/revoke behavior into a blanket PASS. Distinguish the two Publer registrations using client ID.

| Client | Client ID | Class | Baseline result / URL or harness |
|---|---|---|---|
| Social Riddle | `tcm_35acacfeba44f9ff7443cea9f57e19a9` | Interactive | NOT_RUN |
| Charades Collective | `tcm_cd21080b0307695037a1186f0cf032ca` | Interactive | NOT_RUN |
| Stream Elements | `tcm_70d58c063b1f4e97d8a618df44cc2a7f` | Interactive | NOT_RUN |
| Printing | `tcm_0831871c0735d0d45121da851f4b624d` | Interactive | NOT_RUN |
| DiscordManager | `tcm_6ddb70472d9554272208239542c36cd2` | Interactive | NOT_RUN |
| Publer | `tcm_082cae7741ae2ac322c8eafb870839f5` | Interactive | NOT_RUN |
| Publer | `tcm_471a473c4cb73be6bd583bb73a45e887` | Interactive | NOT_RUN |
| StockChecker | `tcm_be01fe57314d0c17c176779004c9cd31` | Interactive | NOT_RUN |
| Test2 | `tcm_4982f6db5b168f2f53da23078f301101` | Interactive | NOT_RUN |
| Giveaways | `tcm_8a4f2ee56492469bff0812d49d2a6022` | Interactive | NOT_RUN |
| My TCM Login Test | `tcm_390446c6131b344f9165198da6909d41` | Interactive | NOT_RUN |
| Hub2 Login | `tcm_38c347da7395d78ca6240655d92eeabc` | Interactive | NOT_RUN |
| Embed Iframe | `tcm_d431e92f8f10b5412183b7c78e95913e` | Interactive | NOT_RUN |
| Giveaway City dev social connections | `tcm_ade6262347f85e0068daabe368f3b776` | Service | NOT_RUN |
| TCM chat bot listings | `tcm_5f78b5cde33bec116232478be63c6ae8` | Service | NOT_RUN |
| TCM chat bot escrow | `tcm_b327e56558863262e1a34500da268df6` | Service | NOT_RUN |
| TCM chat bot system | `tcm_e61b9ceb043a6b1d73c15673ec6b086c` | Service | NOT_RUN |
| TCM chat bot discord-bridge | `tcm_61a641982a8f4bd935a324ebcc5d075e` | Service | NOT_RUN |
| TCM chat bot giftcodes | `tcm_b7c6cca05fa5a18ba74368ac572e8c27` | Service | NOT_RUN |

Start with one accessible interactive app (Social Riddle if available), then report the per-check outcomes. An unavailable app is BLOCKED, not failed. The remaining clients are still tracked independently; one success does not pass all consumers.

Suggested response: Client name + last 8 characters of client ID; development URL/harness; login; profile; refresh; disposable-session logout; retained continuity session available yes/no; error if any. No secret or identifiable account data is needed.

These are baseline observations on the currently deployed version. After any separately approved development rollout, repeat applicable checks against the recorded candidate image and compare results. Current M1b acceptance remains incomplete.
