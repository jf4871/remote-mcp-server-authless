import { OAuthProvider, type OAuthHelpers, type ConsentDescription } from "@cloudflare/workers-oauth-provider";

export interface CalendarOAuthEnv {
  MCP_TOKEN: string;
  OAUTH_KV?: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;
}

type CalendarHandler<E> = (request: Request, env: E, ctx: ExecutionContext) => Response | Promise<Response>;
const scope = "calendar:read";
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function chatgptRedirect(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "chatgpt.com" && !url.port &&
      !url.username && !url.password && !url.hash &&
      (url.pathname.startsWith("/connector/oauth/") || url.pathname === "/connector_platform/oauth/callback");
  } catch {
    return false;
  }
}

async function validOwnerKey(candidate: string, configured: string): Promise<boolean> {
  if (!candidate || !configured) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([candidate, configured].map(value => crypto.subtle.digest("SHA-256", encoder.encode(value))));
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

function loginPage(details: ConsentDescription, handle: string): string {
  return `<!doctype html><html lang="da"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Forbind Proton Calendar til ChatGPT</title>
<body><main><h1>Giv ChatGPT læseadgang til kalenderen</h1>
<p>Forbindelsen <strong>${escapeHtml(details.clientName)}</strong> beder om adgang. Navnet er oplyst af klienten.</p>
<p>Adgangen sendes til <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
<p>Adgangen omfatter kalenderens titler, tidspunkter, steder og beskrivelser. Den kan ikke oprette eller ændre aftaler.</p>
<p>Tilladelse: <code>${scope}</code>. Forbindelsen kan forblive aktiv i op til 30 dage.</p>
<p>Indtast den eksisterende MCP-adgangsnøgle, som allerede bruges af din Codex-forbindelse. Det er ikke din Proton-adgangskode.</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<label>MCP-adgangsnøgle <input type="password" name="owner_key" autocomplete="current-password" maxlength="2048"></label>
<p><button name="decision" value="approve">Godkend læseadgang</button> <button name="decision" value="deny">Afvis</button></p>
</form></main></body></html>`;
}

function privateError(text: string, status: number): Response {
  return new Response(text, { status, headers: {
    "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "Referrer-Policy": "no-referrer",
  } });
}

export async function handleCalendarOAuth<E extends CalendarOAuthEnv>(
  request: Request, env: E, ctx: ExecutionContext, calendarHandler: CalendarHandler<E>,
): Promise<Response> {
  const url = new URL(request.url);
  if (!env.OAUTH_KV || !env.MCP_TOKEN) {
    return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" } });
  }
  const resource = `${url.origin}/mcp`;
  const provider = new OAuthProvider<E>({
    apiRoute: "/mcp",
    apiHandler: { async fetch(req, handlerEnv, handlerCtx) {
      const authCtx = handlerCtx as ExecutionContext & { auth?: { scope?: string[] }; props?: { userId?: string } };
      if (authCtx.props?.userId !== "calendar-owner" || !authCtx.auth?.scope?.includes(scope)) {
        return privateError("Read permission required", 403);
      }
      return calendarHandler(req, handlerEnv, handlerCtx);
    } },
    defaultHandler: { async fetch(req, handlerEnv) {
      if (new URL(req.url).pathname !== "/authorize") return privateError("Not found", 404);
      const oauth = handlerEnv.OAUTH_PROVIDER!;
      if (req.method === "GET") {
        const authRequest = await oauth.parseAuthRequest(req);
        if (!chatgptRedirect(authRequest.redirectUri)) return privateError("Unsupported client redirect", 400);
        const details = await oauth.describeConsent(authRequest);
        const consent = await oauth.beginConsent(authRequest);
        consent.headers.set("Content-Type", "text/html; charset=utf-8");
        consent.headers.set("Cache-Control", "no-store");
        consent.headers.set("Referrer-Policy", "no-referrer");
        consent.headers.set("Content-Security-Policy", "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
        return new Response(loginPage(details, consent.handle), { headers: consent.headers });
      }
      if (req.method !== "POST") return privateError("Method not allowed", 405);
      if (req.headers.get("Origin") !== url.origin) return privateError("Invalid form origin", 403);
      if (!req.headers.get("Content-Type")?.startsWith("application/x-www-form-urlencoded")) return privateError("Unsupported form", 415);
      const formBody = await req.text();
      if (formBody.length > 8192) return privateError("Form too large", 413);
      const form = new URLSearchParams(formBody);
      const handle = form.get("handle") || "";
      if (form.get("decision") === "deny") {
        const denied = await oauth.denyConsent(req, handle);
        denied.headers.set("Cache-Control", "no-store");
        return new Response(null, { status: 302, headers: denied.headers });
      }
      if (form.get("decision") !== "approve" || !(await validOwnerKey(form.get("owner_key") || "", handlerEnv.MCP_TOKEN))) {
        return privateError("Adgangsnøglen blev ikke godkendt. Gå tilbage og prøv igen.", 401);
      }
      const approved = await oauth.approveConsent(req, handle, { scope: [scope, "offline_access"] });
      if (!chatgptRedirect(approved.request.redirectUri)) return privateError("Unsupported client redirect", 400);
      const result = await oauth.completeAuthorization({
        request: approved.request, userId: "calendar-owner", metadata: {},
        scope: [scope, "offline_access"], props: { userId: "calendar-owner" },
      });
      approved.headers.set("Location", result.redirectTo);
      approved.headers.set("Cache-Control", "no-store");
      approved.headers.set("Referrer-Policy", "no-referrer");
      return new Response(null, { status: 302, headers: approved.headers });
    } },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientRegistrationCallback: ({ clientMetadata }) => {
      const redirects = clientMetadata.redirect_uris;
      if (!Array.isArray(redirects) || redirects.length === 0 || !redirects.every(chatgptRedirect)) {
        return { code: "invalid_redirect_uri", description: "Only ChatGPT callback URLs are supported." };
      }
    },
    scopesSupported: [scope, "offline_access"],
    requiredScopes: [scope],
    resourceMetadata: { resource, authorization_servers: [url.origin], resource_name: "Proton Calendar" },
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 24 * 60 * 60,
    clientIdMetadataDocumentEnabled: false,
  });
  try {
    return await provider.fetch(request, env, ctx);
  } catch {
    // Never expose exception messages, form fields, authorization codes or keys.
    return privateError("Forbindelsen kunne ikke godkendes. Start forbindelsen igen fra ChatGPT.", 400);
  }
}
