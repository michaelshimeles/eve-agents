import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";

import {
  Agent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from "undici";

const DEFAULT_DNS_TIMEOUT_MS = 3_000;
const MAX_DEPLOYMENT_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface DeploymentUrlPolicy {
  /** Exact hosts or dot-prefixed suffixes such as `.vercel.app`. */
  readonly allowedHosts: readonly string[];
  readonly allowInsecureLocal: boolean;
  readonly dnsTimeoutMs?: number;
  readonly resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
}

export class UnsafeDeploymentUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeDeploymentUrlError";
  }
}

function normalizeAllowedHost(raw: string): string | null {
  const value = raw.trim().toLowerCase().replace(/\.$/, "");
  if (value.length === 0) return null;
  return value.startsWith("*.") ? `.${value.slice(2)}` : value;
}

export function deploymentUrlPolicyFromEnv(): DeploymentUrlPolicy {
  const allowedHosts = (process.env.IMESSAGE_DEPLOYMENT_DOMAIN_ALLOWLIST ?? "")
    .split(",")
    .map(normalizeAllowedHost)
    .filter((host): host is string => host !== null);
  return {
    allowedHosts,
    allowInsecureLocal:
      process.env.IMESSAGE_ALLOW_INSECURE_LOCAL_URLS?.trim().toLowerCase() === "true",
  };
}

function hostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return allowedHosts.some((entry) => {
    const allowed = normalizeAllowedHost(entry);
    if (allowed === null) return false;
    if (allowed.startsWith(".")) {
      const suffix = allowed.slice(1);
      return host === suffix || host.endsWith(allowed);
    }
    return host === allowed;
  });
}

function ipv4Parts(address: string): readonly number[] | null {
  const parts = address.split(".").map(Number);
  return parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

function isUnsafeIpv4(address: string): boolean {
  const parts = ipv4Parts(address);
  if (parts === null) return true;
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function normalizedIpv6(address: string): string {
  return address.toLowerCase().split("%", 1)[0] ?? "";
}

function mappedIpv4(address: string): string | null {
  const normalized = normalizedIpv6(address);
  const dotted = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted !== undefined) return dotted;
  const hex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex === null) return null;
  const high = Number.parseInt(hex[1] ?? "", 16);
  const low = Number.parseInt(hex[2] ?? "", 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function isUnsafeIpv6(address: string): boolean {
  const normalized = normalizedIpv6(address);
  const mapped = mappedIpv4(normalized);
  if (mapped !== null) return isUnsafeIpv4(mapped);
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  );
}

export function isPublicNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !isUnsafeIpv4(address);
  if (family === 6) return !isUnsafeIpv6(address);
  return false;
}

async function resolvePublicAddresses(
  hostname: string,
  policy: DeploymentUrlPolicy,
): Promise<readonly ResolvedAddress[]> {
  const resolver =
    policy.resolve ??
    (async (host: string) =>
      (await lookup(host, { all: true, verbatim: true })).map((entry) => ({
        address: entry.address,
        family: entry.family as 4 | 6,
      })));
  const timeoutMs = policy.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS;
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () => reject(new UnsafeDeploymentUrlError("deployment host DNS lookup timed out")),
      timeoutMs,
    );
    timer.unref?.();
  });
  const addresses = await Promise.race([resolver(hostname), timeout]);
  if (addresses.length === 0) {
    throw new UnsafeDeploymentUrlError("deployment host has no DNS addresses");
  }
  for (const entry of addresses) {
    if (!isPublicNetworkAddress(entry.address)) {
      throw new UnsafeDeploymentUrlError(
        `deployment host resolves to a non-public address (${entry.address})`,
      );
    }
  }
  return addresses;
}

/**
 * Creates a connector lookup that can return only the already-validated DNS
 * answers. The HTTP/TLS connection therefore cannot perform a second,
 * attacker-controlled lookup between validation and connect (DNS rebinding).
 */
export function pinnedLookup(
  expectedHostname: string,
  resolved: readonly ResolvedAddress[],
): LookupFunction {
  const expected = expectedHostname.toLowerCase().replace(/\.$/, "");
  let cursor = 0;
  return (hostname, options, callback) => {
    const requested = hostname.toLowerCase().replace(/\.$/, "");
    if (requested !== expected) {
      callback(
        Object.assign(new Error("connector requested an unexpected hostname"), {
          code: "EAI_FAIL",
        }),
        "",
        0,
      );
      return;
    }
    const family = options.family === 4 || options.family === 6 ? options.family : 0;
    const candidates =
      family === 0 ? resolved : resolved.filter((entry) => entry.family === family);
    if (candidates.length === 0) {
      callback(
        Object.assign(new Error("validated DNS answers do not match the requested family"), {
          code: "EAI_ADDRFAMILY",
        }),
        "",
        0,
      );
      return;
    }
    if (options.all) {
      callback(
        null,
        candidates.map((entry) => ({
          address: entry.address,
          family: entry.family,
        })),
      );
      return;
    }
    const selected = candidates[cursor % candidates.length];
    cursor += 1;
    callback(null, selected.address, selected.family);
  };
}

function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host) === 4) return ipv4Parts(host)?.[0] === 127;
  if (isIP(host) === 6) {
    const mapped = mappedIpv4(host);
    return normalizedIpv6(host) === "::1" || mapped?.startsWith("127.") === true;
  }
  return false;
}

async function validatedDeployment(
  raw: string,
  policy: DeploymentUrlPolicy,
): Promise<{
  readonly url: string;
  readonly hostname: string;
  readonly addresses: readonly ResolvedAddress[] | null;
}> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeDeploymentUrlError("deployment URL is invalid");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new UnsafeDeploymentUrlError("deployment URL must not contain credentials");
  }
  if (url.hash.length > 0 || url.search.length > 0) {
    throw new UnsafeDeploymentUrlError("deployment URL must not contain a query or fragment");
  }

  const localDevelopment =
    policy.allowInsecureLocal &&
    url.protocol === "http:" &&
    isLocalHostname(url.hostname);
  if (!localDevelopment && url.protocol !== "https:") {
    throw new UnsafeDeploymentUrlError("deployment URL must use HTTPS");
  }

  let addresses: readonly ResolvedAddress[] | null = null;
  if (!localDevelopment) {
    if (policy.allowedHosts.length === 0) {
      throw new UnsafeDeploymentUrlError(
        "IMESSAGE_DEPLOYMENT_DOMAIN_ALLOWLIST must name the permitted deployment hosts",
      );
    }
    if (!hostAllowed(url.hostname, policy.allowedHosts)) {
      throw new UnsafeDeploymentUrlError("deployment host is not on the configured allowlist");
    }
    if (isIP(url.hostname) !== 0) {
      throw new UnsafeDeploymentUrlError("deployment URL must use an allowlisted DNS hostname");
    }
    addresses = await resolvePublicAddresses(url.hostname, policy);
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  return {
    url: `${url.origin}${pathname}`,
    hostname: url.hostname,
    addresses,
  };
}

/**
 * Validates and canonicalizes the callback URL stored in the router registry.
 * The same check must run again immediately before every forward so a DNS
 * change cannot turn a previously public hostname into an internal target.
 */
export async function validateDeploymentUrl(
  raw: string,
  policy: DeploymentUrlPolicy = deploymentUrlPolicyFromEnv(),
): Promise<string> {
  return (await validatedDeployment(raw, policy)).url;
}

export async function fetchValidatedDeployment(
  deploymentUrl: string,
  path: string,
  init: RequestInit,
  policy: DeploymentUrlPolicy = deploymentUrlPolicyFromEnv(),
): Promise<Response> {
  const validated = await validatedDeployment(deploymentUrl, policy);
  const suffix = path.startsWith("/") ? path : `/${path}`;
  const url = `${validated.url}${suffix}`;
  if (validated.addresses === null) {
    return fetch(url, { ...init, redirect: "error" });
  }

  const dispatcher = new Agent({
    connect: {
      lookup: pinnedLookup(validated.hostname, validated.addresses),
    },
  });
  try {
    const response = await undiciFetch(url, {
      ...(init as unknown as UndiciRequestInit),
      redirect: "error",
      dispatcher,
    });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader !== undefined) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_DEPLOYMENT_RESPONSE_BYTES) {
          await reader.cancel();
          throw new UnsafeDeploymentUrlError(
            "deployment response exceeds the permitted byte limit",
          );
        }
        chunks.push(value);
      }
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const headers = new Headers();
    response.headers.forEach((value, key) => headers.append(key, value));
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } finally {
    await dispatcher.close();
  }
}

/**
 * Downloads provider-bound media without allowing redirects or private-network
 * targets. The byte ceiling is enforced while streaming, so an incorrect or
 * missing Content-Length cannot turn a small-looking URL into an unbounded
 * function-memory allocation.
 */
export async function fetchPublicMedia(
  raw: string,
  maxBytes = 100 * 1024 * 1024,
  policy: Pick<DeploymentUrlPolicy, "dnsTimeoutMs" | "resolve"> = {},
): Promise<{ readonly data: Uint8Array; readonly contentType: string | null }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeDeploymentUrlError("media URL is invalid");
  }
  if (url.protocol !== "https:") {
    throw new UnsafeDeploymentUrlError("media URL must use HTTPS");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new UnsafeDeploymentUrlError("media URL must not contain credentials");
  }
  if (isIP(url.hostname) !== 0) {
    throw new UnsafeDeploymentUrlError("media URL must use a public DNS hostname");
  }
  const addresses = await resolvePublicAddresses(url.hostname, {
    allowedHosts: [],
    allowInsecureLocal: false,
    ...policy,
  });

  const dispatcher = new Agent({
    connect: { lookup: pinnedLookup(url.hostname, addresses) },
  });
  try {
    const response = await undiciFetch(url, {
      redirect: "error",
      dispatcher,
    });
    if (!response.ok) {
      throw new UnsafeDeploymentUrlError(`media download returned HTTP ${response.status}`);
    }
    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
      throw new UnsafeDeploymentUrlError("media exceeds the configured byte limit");
    }
    if (response.body === null) {
      return { data: new Uint8Array(), contentType: response.headers.get("content-type") };
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new UnsafeDeploymentUrlError("media exceeds the configured byte limit");
      }
      chunks.push(chunk);
    }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { data, contentType: response.headers.get("content-type") };
  } finally {
    await dispatcher.close();
  }
}
