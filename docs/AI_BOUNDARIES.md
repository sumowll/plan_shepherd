# AI contract

The assistant is an optional language processor. All forms and deterministic comparisons work when it is disabled. `src/server/assistant.ts` enforces the boundary; instructions in patient records and conversation are untrusted data.

## Permitted behavior

1. Choose an approved explanation topic: intake fields, household/employer information, cost terminology, providers, medications, anticipated care, privacy, eligibility or comparison use.
2. Propose a provider name/location or medication name/strength/form explicitly supported by selected record evidence or a user message.
3. Propose anticipated care only when a user explicitly supplied its name, ISO date and numeric quantity. Historical utilization does not establish intended future care.
4. Select the clarification topic for missing details. The application renders approved text rather than unrestricted model prose.

Extracted strings must occur in cited text. Expected-care date and quantity must appear in user evidence. These conservative checks can reject legitimate paraphrases; manual entry remains available. Literal support is not a guarantee of semantic accuracy. Every proposal requires the person's review and explicit acceptance before changing their information.

## Prohibited behavior and enforcement

| Boundary | Enforcement |
| --- | --- |
| Plan recommendation or ranking | No recommendation field, score, tool or raw advice text |
| Diagnosis, treatment, specialist referral or drug substitutes | Approved out-of-scope response; no clinical tools |
| Eligibility and underwriting decisions | Deterministic module; no model eligibility fields |
| Coverage, network and formulary assertions | Catalog identity/rule lookups only |
| Premiums, prices, claim predictions, arithmetic and subsidies | No model price fields; integer-cent domain engine only |
| Invented identifiers and citations | No extracted identifier fields; unknown evidence IDs and unsupported strings rejected |
| Automatic mutation | Separate proposals and explicit acceptance action |
| Record prompt injection | Fixed instructions, records as data and strict output validation |
| Persistent memory or tools | No conversations, background tasks, files, vector stores or retrieval tools |

The adapter implements the OpenAI Responses structured-output contract through a configured HTTPS endpoint. Requests set `store: false` and `background: false`, have bounded input/output and a timeout. The browser sends conversation plus only the record evidence the person selects. It does not automatically send the whole chart. Zod validates outputs. Refusals, incomplete responses and malformed proposals change no information.

`store: false` alone is not Zero Data Retention. Set processing/retention flags only after verifying the actual project, model, endpoint, contract and monitoring/retention settings. See [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data) and [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs). No live patient-data AI call was made during implementation.

Qualify the chosen model using nonpatient examples covering prompt injection, advice requests, invented evidence, ambiguous dates, recurring-event arithmetic and extraction errors. Do not log patient prompts/results for evaluation. Existing tests verify structural restrictions and confirmation behavior; they are not live-model quality validation.
