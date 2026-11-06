# Adding a provider

Use this checklist for every provider so health sensing, routing, model selection,
and operator controls ship together.

- Implement the active probe in `src/core/signal-sources/active-probe/`; add
  public status, balance, or quota signals where the provider supports them.
- Export an adapter factory from `src/core/lane-pipeline.ts` and register it
  in `src/main.ts`'s `PROVIDER_ADAPTERS`.
- Add configurable positive planning/build/review weights in
  `config/routing-policy.yaml`. Weight keys are provider families, not lane IDs.
- Implement a fail-isolated model-list fetcher under
  `src/core/signal-sources/model-list/` and register it in
  `src/core/model-catalog.ts`. Decide defaults in `model-recency.ts`;
  Gemini generations below 3.0 stay disabled by default, including via OpenRouter.
  Explicit operator enable/disable choices survive refreshes.
- Add the provider to `KNOWN_BACKOFF_OVERRIDE_PROVIDERS` in the backoff
  registry and `BACKOFF_OVERRIDE_PROVIDERS` in the dashboard.
- Verify the dashboard catalog refresh, enable/disable controls, and **Create
  route** action. This fills the Add lane provider/model fields from the catalog;
  the operator supplies a unique lane ID and token, saves, then restarts Heimdall
  as the success banner instructs.
- In a separate pantheon-v2 PR, map the provider to its actual CLI in
  `core/api/route.ts`'s `PROVIDER_CLI` (OpenRouter and Grok use opencode).
- Test parsing, authentication, failures, catalog refresh and overrides,
  routing scores, backoff controls, and dashboard script execution.

Model list contracts:
[OpenRouter](https://openrouter.ai/docs/api/api-reference/models/get-models)
(`GET https://openrouter.ai/api/v1/models`) and
[xAI](https://docs.x.ai/developers/rest-api-reference/inference/models)
(`GET https://api.x.ai/v1/models`) return `data[]` with model IDs and
Unix-second `created` values. Missing/invalid dates are retained as null.
