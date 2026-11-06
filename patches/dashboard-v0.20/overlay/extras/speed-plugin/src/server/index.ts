import type { ServerPluginContext } from "@blackbelt-technology/dashboard-plugin-runtime/server";
import {
  getBillingReport,
  getSpeedStats,
  markGenerationEnd,
  markGenerationStart,
} from "./stats.js";

export default async function registerPlugin(
  ctx: ServerPluginContext,
): Promise<void> {
  const httpServer = (
    ctx.fastify as unknown as { server?: { listening?: boolean } }
  ).server;
  if (httpServer?.listening) {
    ctx.logger?.warn?.(
      "speed-monitor: Fastify already listening; skipping route registration.",
    );
    return;
  }

  // Hook into live pi events to track generation start and completion
  if (typeof ctx.onEvent === "function") {
    ctx.onEvent((sessionId: string, rawEvent: unknown) => {
      try {
        const ev = rawEvent as {
          eventType?: string;
          data?: Record<string, unknown>;
          replay?: boolean;
        };
        if (!ev?.eventType) return;
        if (ev.replay === true) {
          markGenerationEnd(sessionId);
          return;
        }

        if (ev.eventType === "message_start") {
          const msg = ev.data?.message as
            | { role?: string; model?: string }
            | undefined;
          if (msg?.role === "assistant") {
            markGenerationStart(
              sessionId,
              typeof msg.model === "string" ? msg.model : undefined,
            );
          }
        } else if (
          (ev.eventType === "message_end" &&
            (ev.data?.message as { role?: string } | undefined)?.role ===
              "assistant") ||
          ev.eventType === "agent_settled" ||
          ev.eventType === "agent_end"
        ) {
          markGenerationEnd(sessionId);
        }
      } catch {
        // Safe guard against unexpected event payloads
      }
    });
  }

  if (typeof ctx.onSessionEnded === "function") {
    ctx.onSessionEnded((sessionId: string) => {
      markGenerationEnd(sessionId);
    });
  }

  try {
    ctx.fastify.get<{ Querystring: { month?: string } }>(
      "/api/speed-monitor/billing",
      {
        schema: {
          querystring: {
            type: "object",
            additionalProperties: false,
            properties: {
              month: { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])$" },
            },
          },
        },
      },
      async (req) =>
        getBillingReport(req.query?.month, ctx.sessionManager.listAll()),
    );
    ctx.fastify.get<{ Querystring: { sessionId?: string; month?: string } }>(
      "/api/speed-monitor/stats",
      {
        schema: {
          querystring: {
            type: "object",
            additionalProperties: false,
            properties: {
              month: { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])$" },
              sessionId: {
                type: "string",
                minLength: 1,
                maxLength: 200,
                pattern: "^[A-Za-z0-9_.-]+$",
                not: { enum: [".", ".."] },
              },
            },
          },
        },
      },
      async (req) => {
        const sessionId = req.query?.sessionId;
        const session = sessionId
          ? (ctx.sessionManager.getSession(sessionId) as
              | { sessionFile?: string; originDeviceId?: string }
              | undefined)
          : undefined;
        const stats = await getSpeedStats(
          sessionId,
          session?.originDeviceId ? undefined : session?.sessionFile,
          req.query.month,
        );
        return stats;
      },
    );
    ctx.logger?.info?.(
      "speed-monitor: registered /api/speed-monitor/stats endpoint",
    );
  } catch (err) {
    ctx.logger?.warn?.(
      `speed-monitor: route registration failed (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}
