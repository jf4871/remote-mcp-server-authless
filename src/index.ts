
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import ICAL from "ical.js";
import { handleCalendarOAuth, type CalendarOAuthEnv } from "./oauth";

interface CalendarEnv extends CalendarOAuthEnv {
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

// Keep the feed's calendar records and recurrence rules. Do not silently turn
// a recurring series into one appointment or expand an unbounded recurrence.
function calendarFromIcs(body: string) {
  if (body.length > 5_000_000) throw new Error("Calendar size limit");
  const calendar = new ICAL.Component(ICAL.parse(body));
  if (calendar.name !== "vcalendar") throw new Error("Expected VCALENDAR");
  const components = calendar.getAllSubcomponents("vevent");
  if (components.length > 5_000) throw new Error("Calendar event limit");

  function dateValue(time: ICAL.Time, property?: ICAL.Property | null) {
    if (!time) throw new Error("Missing event date");
    const declaredZone = property?.getParameter("tzid");
    const timeZone = time.isDate ? null : String(declaredZone || time.zone.tzid);
    // Unknown/floating zones must not be falsely reported as UTC.
    const utc = !time.isDate && time.zone.tzid !== "floating"
      ? time.toJSDate().toISOString()
      : null;
    return { value: time.toString(), timeZone, utc };
  }

  const events = components.map((component) => {
    const event = new ICAL.Event(component);
    const startProperty = component.getFirstProperty("dtstart");
    const endProperty = component.getFirstProperty("dtend");
    const start = dateValue(event.startDate, startProperty);
    const end = dateValue(event.endDate, endProperty || startProperty);
    const recurrenceId = component.getFirstProperty("recurrence-id");
    const rules = component.getAllProperties("rrule")
      .map((property) => String(property.getFirstValue()));
    const dates = (name: string) => component.getAllProperties(name).flatMap((property) =>
      property.getValues().map((value) => {
        if (value instanceof ICAL.Time) return dateValue(value, property);
        if (value instanceof ICAL.Period) {
          return { start: dateValue(value.start, property), end: dateValue(value.getEnd(), property) };
        }
        throw new Error("Unsupported recurrence date");
      }),
    );

    return {
      uid: event.uid || null,
      title: event.summary || "",
      start,
      end,
      allDay: event.startDate.isDate,
      location: event.location || "",
      description: event.description || "",
      status: component.getFirstPropertyValue("status") || null,
      recurrence: {
        rules,
        additionalDates: dates("rdate"),
        excludedDates: dates("exdate"),
        recurrenceId: recurrenceId ? dateValue(event.recurrenceId, recurrenceId) : null,
        range: recurrenceId?.getParameter("range") || null,
      },
    };
  });
  events.sort((a, b) => (a.start.utc || a.start.value).localeCompare(b.start.utc || b.start.value));
  return {
    format: "icalendar",
    eventCount: events.length,
    recurrenceExpanded: false,
    note: "Kalenderposter fra ICS. Gentagne aftaler er ikke udfoldet til enkelte forekomster: brug recurrence-regler, undtagelser og status ved spørgsmål om bestemte datoer. Slutdatoen for heldagsaftaler er eksklusiv. Tider uden tidszone er lokale/flydende tider.",
    events,
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
      annotations: { readOnlyHint: true, destructiveHint: false },
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
        try {
          const data = calendarFromIcs(trimmed);
          return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
        } catch {
          // Parser errors may contain feed contents or private URLs.
          return calendarError("CALENDAR_ICS_INVALID", "Kalenderkilden returnerede ICS, men kalenderen kunne ikke læses eller overskred størrelsesgrænsen.");
        }
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
      return handleCalendarOAuth(request, env, ctx, (req, handlerEnv, handlerCtx) =>
        createMcpHandler(() => createServer(handlerEnv))(req, handlerEnv, handlerCtx));
    }

    const handler = createMcpHandler(
      () => createServer(env),
    );

    return handler(request, env, ctx);
  },
};
