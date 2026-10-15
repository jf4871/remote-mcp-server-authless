# ChatGPT calendar connection

The existing Codex connection sends `MCP_TOKEN` as a Bearer header. ChatGPT's custom-MCP dialog offers OAuth or no authentication, not a field for this static header. Configuring a server locally in Codex does not by itself install a personal ChatGPT plugin.

The Worker now also serves OAuth discovery, dynamic client registration, authorization, token exchange and refresh, using `@cloudflare/workers-oauth-provider` 1.2.3. Its original Bearer-key connection still works. The calendar tool is marked read-only.

## Connect

1. Open ChatGPT Plugins, choose Add custom MCP server and name it Proton Calendar.
2. Use the existing Worker `/mcp` endpoint and OAuth authentication. Choose Dynamic Client Registration after discovery succeeds.
3. Create/install the personal plugin and start its connection flow.
4. On the Worker's authorization page, verify the recipient is `chatgpt.com`. Enter the existing **MCP_TOKEN** privately and approve calendar read access. This is **not** the Proton account password or the calendar sharing URL. Never put the key in chat, source files, PRs, or the plugin package.
5. Invoke the installed plugin with `@Proton Calendar` in a Work chat and verify an actual `get_calendar_events` call. Registration or installation alone is not a successful end-to-end test.

Only ChatGPT HTTPS connector callback URLs can register. A browser-bound, one-use consent handle, an origin check and the owner key protect approval. Client names are escaped and explicitly described as self-asserted. The provider validates PKCE, token audience, grant expiry and replay. The MCP handler also checks the calendar-owner identity and `calendar:read` scope. Access tokens live for one hour; refresh grants expire after 30 days. Reauthorizing a client replaces its previous grant. Consent never stores or returns the owner key.

Production and previews use separate `OAUTH_KV` namespaces. No production secrets are copied to previews. The identifiers in Wrangler configuration are resource identifiers, not credentials. Missing OAuth storage or a missing owner key fails closed.

## Local verification

Use the synthetic-only `oauth-test.wrangler.jsonc` configuration. It is never the production deployment configuration. Start Wrangler locally on `127.0.0.1:8789` with this configuration, then run `node tests/calendar-oauth.integration.mjs` in another terminal. The test starts a synthetic calendar source on `127.0.0.1:8879` and performs discovery, registration, owner consent, PKCE exchange, MCP initialization, tool listing and a calendar read, refresh, plus rejection checks. The regular `npm test` retains the 29 diagnostics/calendar checks. `npm run type-check` validates TypeScript.

For a real-browser form regression check, run `node tests/calendar-oauth.browser-fixture.mjs` alongside the synthetic local Worker. Open `http://127.0.0.1:8878/start` and submit the consent form with an **empty** key. The expected response is a key rejection (401), not `Invalid form origin` (403). No production key or grant is used. The consent page uses `Referrer-Policy: same-origin`: `no-referrer` makes browser form POSTs send `Origin: null`, despite being same-origin. Cross-origin URLs receive no referrer; the strict Origin check and browser-bound consent handle remain required. Error and final redirect responses retain `no-referrer`.

Limitations: the owner must complete the private key entry and consent. ChatGPT installation, account restrictions, model/tool availability and a real ChatGPT call must be checked separately. ICS recurrence records remain unexpanded, as documented in the previous calendar-format change.
