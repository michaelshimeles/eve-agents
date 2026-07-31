import type { LocalComputerRelayError } from "@/agent/lib/effect/local-computer-relay";

const DEFAULT_DOWNLOAD_URL =
  "https://github.com/boringcomputers/ruth/releases/latest/download/Ruth-Local.dmg";

export function ruthLocalDownloadUrl(): string {
  const configured = process.env.RUTH_LOCAL_DOWNLOAD_URL?.trim();
  return configured !== undefined && configured.length > 0
    ? configured
    : DEFAULT_DOWNLOAD_URL;
}

export function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization === null) return null;
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

export function localComputerApiFailure(error: unknown): Response {
  const relayError =
    error !== null &&
    typeof error === "object" &&
    "_tag" in error &&
    (error as { _tag?: unknown })._tag === "LocalComputerRelayError"
      ? (error as LocalComputerRelayError)
      : null;
  const message =
    error instanceof Error
      ? error.message
      : relayError?.detail ?? "Ruth Local request failed.";
  const normalized = message.toLowerCase();
  const status =
    relayError?.reason === "unauthorized" ||
    normalized.includes("authorization failed")
      ? 401
      : relayError?.reason === "not_found" || normalized.includes("not found")
        ? 404
        : relayError?.reason === "expired" ||
            normalized.includes("pairing expired")
          ? 410
          : relayError?.reason === "invalid" ||
              normalized.includes("pairing refused") ||
              normalized.includes("invalid")
            ? 400
            : relayError?.reason === "timeout" ||
                normalized.includes("offline") ||
                normalized.includes("timed out")
              ? 504
              : relayError?.reason === "not_paired" ||
                  normalized.includes("not paired")
                ? 409
                : normalized.includes("not configured") ||
                    normalized.includes("database_url")
                  ? 503
                  : 500;
  return Response.json({ error: message }, { status });
}

export function stringField(
  value: unknown,
  name: string,
  maximum = 20_000,
): string {
  if (value === null || typeof value !== "object") return "";
  const field = (value as Record<string, unknown>)[name];
  return typeof field === "string" && field.length <= maximum ? field : "";
}

export function stringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, item]) =>
      typeof item === "string" ? [[name, item] as const] : [],
    ),
  );
}
