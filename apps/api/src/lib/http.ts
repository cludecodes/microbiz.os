import type { Context, TypedResponse } from "hono";
import type { Env } from "../types";

export type ApiResultError = Record<string, unknown> & { error: string; detail?: string };

/**
 * Typed error return usable as `return jsonError(..., 403, "...")` in any
 * handler position (assignable to Response and never-thrown).
 */
export function jsonError(
  c: Context<{ Bindings: Env }>,
  status: number,
  error: string,
  detail?: string
): never {
  return c.json({ error, detail }, status as never) as never;
}

export function zodMessage(error: unknown): string {
  const parts: string[] = [];
  if (error && typeof error === "object" && "issues" in error) {
    for (const issue of (error as { issues: { path: (string | number)[]; message: string }[] }).issues) {
      parts.push(`${issue.path.join(".")}: ${issue.message}`);
    }
  }
  return parts.join("; ") || "Invalid request body";
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function uuid(): string {
  return crypto.randomUUID();
}
