
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

interface CalendarEnv {
  MCP_TOKEN: string;
  PROTON_API_KEY: string;
  PROTON_API_URL: string;
}

function calendarError(code: string, explanation: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: `[${code}] ${explanation}` }],
  };
}

function createServer(env: CalendarEnv) {
  const server = new McpServer({
    name: "Proton Calendar",
    version: "1.0.0",
  });

  server.registerTool(
    "get_calendar_events",
    {
      description:
        "Hent begivenheder fra brugerens Proton Calendar. " +
        "Returnerer kalenderens begivenheder med titler, " +
        "start- og sluttidspunkter samt eventuelle steder " +
        "og beskrivelser. Kalenderen er kun til læsning.",
      inputSchema: z.object({}),
    },
    async () => {
      if (!env.PROTON_API_URL?.trim()) {
        return calendarError("CALENDAR_URL_MISSING", "PROTON_API_URL mangler i denne Worker.");
      }
      try {
        const url = new URL(env.PROTON_API_URL);
        if (url.protocol !== "https:" && url.protocol !== "http:") {
          return calendarError("CALENDAR_URL_SCHEME", "Kalenderadressen bruger ikke HTTP eller HTTPS.");
        }
      } catch {
        return calendarError("CALENDAR_URL_INVALID", "PROTON_API_URL er ikke en gyldig, fuld adresse.");
      }

      let headers: Headers;
      try {
        headers = new Headers({ Authorization: `Bearer ${env.PROTON_API_KEY}` });
      } catch {
        return calendarError("CALENDAR_KEY_FORMAT", "PROTON_API_KEY kan ikke bruges som HTTP-header. Kontrollér formateringen i Cloudflare.");
      }

      let response: Response;
      try {
        response = await fetch(env.PROTON_API_URL, { headers });
      } catch {
        // Never return exception messages: they can contain URLs or credentials.
        return calendarError("CALENDAR_FETCH_FAILED", "Workerens forespørgsel til kalenderkilden fejlede før et HTTP-svar blev modtaget.");
      }

      if (!response.ok) {
        return calendarError("CALENDAR_HTTP_ERROR", `Kalenderkilden returnerede HTTP ${response.status}.`);
      }

      let body: string;
      try {
        body = await response.text();
      } catch {
        return calendarError("CALENDAR_BODY_READ_FAILED", "HTTP-svaret blev modtaget, men svarets indhold kunne ikke læses.");
      }

      const trimmed = body.trim();
      if (/^BEGIN:VCALENDAR(?:\r?\n|$)/i.test(trimmed)) {
        return calendarError("CALENDAR_ICS_FORMAT", "Kalenderkilden returnerede iCalendar (ICS). Denne version forventer JSON; forbindelsen virker, men kalenderformatet skal understøttes.");
      }
      if (/^<!doctype\s+html\b|^<html\b/i.test(trimmed)) {
        return calendarError("CALENDAR_HTML_FORMAT", "Kalenderkilden returnerede en HTML-side i stedet for kalenderdata. Kontrollér, at adressen er et data-endpoint og ikke en login- eller visningsside.");
      }
      if (!trimmed) {
        return calendarError("CALENDAR_EMPTY_RESPONSE", "Kalenderkilden returnerede et tomt svar.");
      }

      try {
        const data = JSON.parse(body);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch {
        return calendarError("CALENDAR_INVALID_JSON", "Kalenderkilden svarede, men indholdet er ikke gyldig JSON.");
      }
    },
  );

  return server;
}

export default {
  fetch(
    request: Request,
    env: CalendarEnv,
    ctx: ExecutionContext,
  ) {
    const token = env.MCP_TOKEN;

    if (
      !token ||
      request.headers.get("Authorization") !==
        `Bearer ${token}`
    ) {
      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": "Bearer",
          "Cache-Control": "no-store",
        },
      });
    }

    const handler = createMcpHandler(
      () => createServer(env),
    );

    return handler(request, env, ctx);
  },
};
