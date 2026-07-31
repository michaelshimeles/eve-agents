import {
  AgentMailError,
  createDomain,
  deleteDomain,
  getDomain,
  getEmailAddress,
  getInbox,
  invalidateInboxCache,
  listDomains,
  verifyDomain,
  type EmailDomain,
} from "./agentmail";
import {
  clearConnectedDomain,
  getConnectedDomain,
  markDomainVerified,
  saveConnectedDomain,
} from "./email-db";

// The custom-domain workflow, shared by the agent's tools and the email page:
// connect a domain (register it with AgentMail and get DNS records back),
// watch it verify, then move the agent's address onto it. The chosen domain
// lives in Neon; AgentMail only knows which domains exist, not which one this
// agent's address should use.

const DOMAIN_PATTERN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

export function normalizeDomain(raw: string): string | null {
  const domain = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");
  return DOMAIN_PATTERN.test(domain) ? domain : null;
}

export interface DomainState {
  connected: boolean;
  domain?: string;
  status?: EmailDomain["status"];
  records?: EmailDomain["records"];
  /** True once the agent's address actually lives on the domain. */
  active?: boolean;
  emailAddress: string;
  connectedAt?: string;
}

/**
 * Registers `domain` with AgentMail and remembers it as the agent's domain.
 * Reuses a domain the account already has, so re-connecting is idempotent.
 * Returns the DNS records the user must add at their registrar.
 */
export async function connectEmailDomain(rawDomain: string): Promise<DomainState> {
  const domain = normalizeDomain(rawDomain);
  if (domain === null) {
    throw new Error(`"${rawDomain}" does not look like a domain name (e.g. example.com).`);
  }

  let detail: EmailDomain;
  try {
    detail = await createDomain(domain);
  } catch (error) {
    // Already registered on this account is fine - adopt it.
    const existing = error instanceof AgentMailError ? await findDomain(domain) : null;
    if (existing === null) throw error;
    detail = await getDomain(existing.domain_id);
  }

  await saveConnectedDomain(domain, detail.domain_id);
  if (detail.status === "NOT_STARTED") {
    // The documented kick that starts AgentMail watching for the records.
    await verifyDomain(detail.domain_id).catch(() => undefined);
  }
  return await domainState(detail);
}

/**
 * Where the connected domain stands right now. Re-kicks verification when
 * AgentMail is waiting on us, and the moment the domain reports VERIFIED,
 * moves the agent's address onto it (the old inbox keeps its mail).
 */
export async function checkEmailDomain(): Promise<DomainState> {
  const connected = await getConnectedDomain();
  if (connected === null) return { connected: false, emailAddress: await getEmailAddress() };

  const detail = await getDomain(connected.domain_id);
  if (detail.status === "NOT_STARTED" || detail.status === "FAILED") {
    await verifyDomain(connected.domain_id).catch(() => undefined);
  }

  if (detail.status === "VERIFIED" && connected.verified_at === null) {
    await markDomainVerified(connected.domain);
    // Re-resolve eagerly so the switch happens now, not on some later call.
    invalidateInboxCache();
    await getInbox();
  }
  return await domainState(detail, connected.connected_at);
}

/**
 * Disconnects the custom domain: removes it from AgentMail and points the
 * agent's address back at agentmail.to. Mail already in the custom-domain
 * inbox stays there (pin it with AGENTMAIL_INBOX_ID to read it again).
 */
export async function removeEmailDomain(): Promise<DomainState> {
  const connected = await getConnectedDomain();
  if (connected !== null) {
    await deleteDomain(connected.domain_id).catch((error: unknown) => {
      // Gone on their side is the outcome we wanted.
      if (!(error instanceof AgentMailError && error.status === 404)) throw error;
    });
    await clearConnectedDomain();
    invalidateInboxCache();
  }
  return { connected: false, emailAddress: await getEmailAddress() };
}

async function findDomain(domain: string): Promise<EmailDomain | null> {
  const domains = await listDomains();
  return domains.find((entry) => entry.domain.toLowerCase() === domain) ?? null;
}

async function domainState(detail: EmailDomain, connectedAt?: string): Promise<DomainState> {
  const emailAddress = await getEmailAddress();
  return {
    connected: true,
    domain: detail.domain,
    status: detail.status,
    records: detail.records,
    active: emailAddress.toLowerCase().endsWith(`@${detail.domain.toLowerCase()}`),
    emailAddress,
    connectedAt,
  };
}
