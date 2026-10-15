
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

interface CalendarEnv {
  MCP_TOKEN: string;
  PROTON_API_KEY: string;
  PROTON_API_URL: string;
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
      try {
        const response = await fetch(env.PROTON_API_URL, {
          headers: {
            Authorization: `Bearer ${env.PROTON_API_KEY}`,
          },
        });

        if (!response.ok) {
          return {
            isError: true,
            content: [{
              type: "text",
              text: `Kalender-API returnerede HTTP ${response.status}`,
            }],
          };
        }

        const data = await response.json();

        return {
          content: [{
            type: "text",
            text: JSON.stringify(data, null, 2),
          }],
        };
      } catch {
        return {
          isError: true,
          content: [{
            type: "text",
            text: "Kunne ikke hente kalenderen.",
          }],
        };
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
