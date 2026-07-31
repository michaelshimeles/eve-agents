// A local stand-in for Agentcard, for exercising the payment capability
// without an Agentcard account (which needs a real email, phone, and card).
// Speaks the two surfaces the app touches: the backend-only Connect REST API
// and the MCP server itself over Streamable HTTP. Legacy OAuth endpoints stay
// in this stand-in only so older local checkouts can still boot; Ruth never
// routes a user through them.
//
//   node scripts/agentcard-stub.mjs                     # 127.0.0.1:4546
//   AGENTCARD_MCP_URL=http://127.0.0.1:4546/mcp npm run dev
//
// Connect and phone-verification codes are always 111111 like the real
// sandbox. After connecting by email, verify a phone, then the attach URL
// renders a local "Complete test attachment" button:
//
//   AGENTCARD_API_URL=http://127.0.0.1:4546 \
//   AGENTCARD_MCP_URL=http://127.0.0.1:4546/mcp \
//   AGENTCARD_CLIENT_ID=cl_stub AGENTCARD_CLIENT_SECRET=acs_stub \
//   npm run dev
//
// STUB_TOKEN_TTL_SECONDS shortens access-token lifetime (default 3600) to
// exercise the refresh path. STUB_TOKEN_DELAY_MS holds every /token response
// for that long, widening the window for exercising concurrent refreshes
// (refresh tokens rotate on use here, like the real service).
// STUB_REQUIRE_APPROVAL=true makes create_card and get_card_details return
// approval_required so approve_request can be exercised locally.

import { createHash, randomUUID, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number.parseInt(process.env.PORT ?? "4546", 10);
const ORIGIN = process.env.STUB_ORIGIN ?? `http://127.0.0.1:${PORT}`;
const TOKEN_TTL_SECONDS = Number.parseInt(process.env.STUB_TOKEN_TTL_SECONDS ?? "3600", 10);
const TOKEN_DELAY_MS = Number.parseInt(process.env.STUB_TOKEN_DELAY_MS ?? "0", 10);
const REQUIRE_APPROVAL = process.env.STUB_REQUIRE_APPROVAL === "true";

/** @type {Map<string, {client_id: string, redirect_uris: string[]}>} */
const clients = new Map();
/** @type {Map<string, {client_id: string, redirect_uri: string, challenge: string}>} */
const codes = new Map();
/** @type {Map<string, {client_id: string, expires_at: number}>} */
const accessTokens = new Map();
/** @type {Map<string, {client_id: string}>} */
const refreshTokens = new Map();

// Company-mode state: platform tokens from client_credentials, pending
// connect attempts, and user refresh tokens (rotate on use, like personal).
/** @type {Map<string, {expires_at: number}>} */
const platformTokens = new Map();
/** @type {Map<string, {email?: string, phone?: string}>} */
const connectAttempts = new Map();
/** @type {Map<string, {user_id: string}>} */
const companyRefreshTokens = new Map();
const COMPANY_CODE = "111111";
const consents = new Set();
/** @type {Map<string, {phone_number: string, expires_at: number}>} */
const phoneVerifications = new Map();
/** @type {Map<string, {id: string, user_id: string, status: "pending" | "active" | "ineligible", attach_url?: string, expires_at?: string, card?: {brand: string, last4: string}, reason?: string, message?: string}>} */
const attachments = new Map();
/** @type {Map<string, string>} */
const latestAttachmentByUser = new Map();

/** A user connection token pair; the access token spends on /mcp directly. */
function issueCompanyConnection() {
  const access = `user_at_${base64url(randomBytes(12))}`;
  const refresh = `user_rt_${base64url(randomBytes(12))}`;
  accessTokens.set(access, {
    client_id: "company",
    expires_at: Date.now() + TOKEN_TTL_SECONDS * 1000,
  });
  companyRefreshTokens.set(refresh, { user_id: "user_stub" });
  return {
    object: "connection",
    access_token: access,
    refresh_token: refresh,
    token_type: "Bearer",
    expires_in: TOKEN_TTL_SECONDS,
    user: { id: "user_stub", email: account.email, phone: account.phone },
  };
}

const account = {
  email: "owner@example.com",
  phone: null,
  name: "Test Owner",
  plan: "free",
  /** Cash balance in cents. */
  balance_cents: 12_500,
  kyc: "approved",
};

/** @type {Map<string, any>} */
const cards = new Map();
/** @type {any[]} */
const transactions = [];
/** @type {Map<string, {action: "transaction" | "card_details", resource_id: string, arguments?: any}>} */
const pendingApprovals = new Map();

function json(response, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function base64url(buffer) {
  return buffer.toString("base64url");
}

// --- OAuth -----------------------------------------------------------------

function metadata() {
  return {
    issuer: `${ORIGIN}/`,
    service_documentation: "https://agentcard.sh/",
    authorization_endpoint: `${ORIGIN}/authorize`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint: `${ORIGIN}/token`,
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    revocation_endpoint: `${ORIGIN}/revoke`,
    registration_endpoint: `${ORIGIN}/register`,
  };
}

function issueTokens(clientId) {
  const accessToken = `stub_at_${base64url(randomBytes(24))}`;
  const refreshToken = `stub_rt_${base64url(randomBytes(24))}`;
  accessTokens.set(accessToken, {
    client_id: clientId,
    expires_at: Date.now() + TOKEN_TTL_SECONDS * 1000,
  });
  refreshTokens.set(refreshToken, { client_id: clientId });
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
  };
}

/** The consent screen. Submitting it is what mints the authorization code. */
function authorizePage(query) {
  const params = new URLSearchParams(query).toString();
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Agentcard (stub) — authorize</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; display: grid; place-items: center;
         min-height: 100vh; background: #0b0b0f; color: #e8e8ed; }
  .card { background: #16161c; border: 1px solid #26262f; border-radius: 14px;
          padding: 32px; width: 380px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p { color: #9a9aa8; font-size: 14px; margin: 0 0 20px; }
  .row { display: flex; align-items: baseline; justify-content: space-between;
         border-top: 1px solid #26262f; padding: 10px 0; font-size: 13px; }
  .row span:first-child { color: #9a9aa8; }
  button { width: 100%; margin-top: 20px; padding: 11px; font-size: 15px; font-weight: 600;
           border: 0; border-radius: 9px; background: #635bff; color: #fff; cursor: pointer; }
  .stub { margin-top: 14px; text-align: center; font-size: 12px; color: #5f5f6d; }
</style></head>
<body><div class="card">
  <h1>Authorize eveclaw</h1>
  <p>eveclaw wants to create and manage virtual cards on your Agentcard account.</p>
  <div class="row"><span>Account</span><span>${account.email}</span></div>
  <div class="row"><span>Balance</span><span>$${(account.balance_cents / 100).toFixed(2)}</span></div>
  <div class="row"><span>Plan</span><span>${account.plan}</span></div>
  <form method="POST" action="/authorize?${params}"><button type="submit">Allow access</button></form>
  <p class="stub">Local Agentcard stub — no real money involved.</p>
</div></body></html>`;
}

// --- Cards -----------------------------------------------------------------

function cardView(card, withSecrets = false) {
  const view = {
    id: card.id,
    last4: card.pan.slice(-4),
    type: card.type,
    status: card.status,
    limit_cents: card.limit_cents,
    balance_cents: card.balance_cents,
    expiry: `${card.exp_month}/${card.exp_year}`,
    created_at: card.created_at,
  };
  if (!withSecrets) return view;
  return { ...view, pan: card.pan, cvv: card.cvv, exp_month: card.exp_month, exp_year: card.exp_year };
}

function createCard(amountCents, type) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error("amount_cents must be a positive integer number of cents");
  }
  if (amountCents > 5_000) {
    throw new Error("Card limit exceeds the free plan cap of $50.00. Upgrade the plan first.");
  }
  if (amountCents > account.balance_cents) {
    throw new Error(
      `Balance is $${(account.balance_cents / 100).toFixed(2)}, which is short of $${(amountCents / 100).toFixed(2)}. Call add_funds first.`,
    );
  }
  account.balance_cents -= amountCents;
  const card = {
    id: `card_${randomUUID().slice(0, 8)}`,
    pan: `447624${String(Math.floor(Math.random() * 1e10)).padStart(10, "0")}`,
    cvv: String(Math.floor(Math.random() * 900) + 100),
    exp_month: 12,
    exp_year: new Date().getFullYear() + 3,
    type: type === "multi_use" ? "multi_use" : "single_use",
    status: "open",
    limit_cents: amountCents,
    balance_cents: amountCents,
    created_at: new Date().toISOString(),
  };
  cards.set(card.id, card);
  return card;
}

function requireCard(id) {
  const card = cards.get(id);
  if (card === undefined) throw new Error(`No card with id ${id}`);
  return card;
}

// --- MCP tools -------------------------------------------------------------

const TOOLS = {
  get_instructions: {
    description: "Fetch the latest usage guide for spending with Agentcard.",
    schema: { type: "object", properties: {} },
    run: () => ({
      guide:
        "Amounts are in cents. Create a card sized to the purchase, read its details to fill the payment form, and let single-use cards close themselves after the charge.",
    }),
  },
  whoami: {
    description: "Show which account this session operates.",
    schema: { type: "object", properties: {} },
    run: () => ({ email: account.email, name: account.name, plan: account.plan, kyc: account.kyc }),
  },
  get_balance: {
    description: "Show the cash balance available for cards.",
    schema: { type: "object", properties: {} },
    run: () => ({
      balance_cents: account.balance_cents,
      currency: "USD",
    }),
  },
  add_funds: {
    description: "Add money to the balance with Apple Pay or Google Pay.",
    schema: {
      type: "object",
      properties: { amount_cents: { type: "integer" } },
      required: ["amount_cents"],
    },
    run: ({ amount_cents: amount }) => ({
      checkout_url: `${ORIGIN}/checkout/${randomUUID().slice(0, 8)}?amount_cents=${amount}`,
      amount_cents: amount,
      note: "Send this link to the user; the funds land once they complete the payment.",
    }),
  },
  create_card: {
    description: "Create a new virtual card funded from the balance.",
    schema: {
      type: "object",
      properties: {
        amount_cents: { type: "integer" },
        type: { type: "string", enum: ["single_use", "multi_use"] },
      },
      required: ["amount_cents"],
    },
    run: ({ amount_cents: amount, type }) => {
      if (REQUIRE_APPROVAL) {
        const approvalId = `appr_${randomUUID().slice(0, 8)}`;
        pendingApprovals.set(approvalId, {
          action: "transaction",
          resource_id: approvalId,
          arguments: { amount_cents: amount, type },
        });
        return {
          status: "approval_required",
          approvalId,
          action: "transaction",
          resource_id: approvalId,
          message: "Approve this request before the card is created.",
        };
      }
      return {
        status: "created",
        card: cardView(createCard(amount, type)),
        balance_cents: account.balance_cents,
      };
    },
  },
  list_cards: {
    description: "List all your virtual cards with balances and status.",
    schema: { type: "object", properties: {} },
    run: () => ({
      cards: [...cards.values()].map((card) => cardView(card)),
      balance_cents: account.balance_cents,
    }),
  },
  get_card_details: {
    description: "Get the full card number, CVV, and expiry for a card.",
    schema: {
      type: "object",
      properties: { card_id: { type: "string" } },
      required: ["card_id"],
    },
    run: ({ card_id: cardId }) => {
      if (REQUIRE_APPROVAL) {
        requireCard(cardId);
        const approvalId = `appr_${randomUUID().slice(0, 8)}`;
        pendingApprovals.set(approvalId, {
          action: "card_details",
          resource_id: cardId,
        });
        return {
          status: "approval_required",
          approvalId,
          action: "card_details",
          resource_id: cardId,
          message: "Confirm before revealing card credentials.",
        };
      }
      return { status: "details", card: cardView(requireCard(cardId), true) };
    },
  },
  approve_request: {
    description: "Approve or deny the immediately preceding Agentcard request.",
    schema: {
      type: "object",
      properties: {
        approval_id: { type: "string" },
        decision: { type: "string", enum: ["approved", "denied"] },
        action: { type: "string" },
        resource_id: { type: "string" },
      },
      required: ["approval_id", "decision", "action", "resource_id"],
    },
    run: ({ approval_id: approvalId, decision, action, resource_id: resourceId }) => {
      const pending = pendingApprovals.get(approvalId);
      if (
        pending === undefined ||
        pending.action !== action ||
        pending.resource_id !== resourceId
      ) {
        return { status: "unknown_action", message: "Approval request not found." };
      }
      pendingApprovals.delete(approvalId);
      if (decision !== "approved") return { status: "denied" };
      if (pending.action === "card_details") {
        return {
          status: "card_details",
          card: cardView(requireCard(pending.resource_id), true),
        };
      }
      const args = pending.arguments ?? {};
      return {
        status: "card_created",
        card: cardView(createCard(args.amount_cents, args.type)),
        balance_cents: account.balance_cents,
      };
    },
  },
  get_card_balance: {
    description: "Check the live balance on one virtual card.",
    schema: {
      type: "object",
      properties: { card_id: { type: "string" } },
      required: ["card_id"],
    },
    run: ({ card_id: cardId }) => {
      const card = requireCard(cardId);
      return { card_id: card.id, balance_cents: card.balance_cents, status: card.status };
    },
  },
  close_card: {
    description: "Permanently close a virtual card.",
    schema: {
      type: "object",
      properties: { card_id: { type: "string" } },
      required: ["card_id"],
    },
    run: ({ card_id: cardId }) => {
      const card = requireCard(cardId);
      account.balance_cents += card.balance_cents;
      card.balance_cents = 0;
      card.status = "closed";
      return { card: cardView(card), balance_cents: account.balance_cents };
    },
  },
  list_transactions: {
    description: "List transactions for one card, or across the whole account.",
    schema: {
      type: "object",
      properties: { card_id: { type: "string" }, limit: { type: "integer" } },
    },
    run: ({ card_id: cardId }) => ({
      transactions: transactions.filter((entry) => cardId === undefined || entry.card_id === cardId),
    }),
  },
  // Simulates a merchant charging a card, so the single-use lifecycle and the
  // receipts follow-up can be exercised without a real checkout.
  buy: {
    description: "Shop and check out at linked merchants using natural language.",
    schema: {
      type: "object",
      properties: { request: { type: "string" }, card_id: { type: "string" } },
      required: ["request"],
    },
    run: ({ request, card_id: cardId }) => {
      const card = cardId === undefined ? [...cards.values()].find((c) => c.status === "open") : requireCard(cardId);
      if (card === undefined) throw new Error("No open card to charge. Create one first.");
      const amount = Math.min(card.balance_cents, Math.round(card.balance_cents * 0.8));
      card.balance_cents -= amount;
      if (card.type === "single_use") {
        account.balance_cents += card.balance_cents;
        card.balance_cents = 0;
        card.status = "closed";
      }
      const transaction = {
        id: `txn_${randomUUID().slice(0, 8)}`,
        card_id: card.id,
        merchant: "Stub Merchant",
        amount_cents: amount,
        status: "approved",
        created_at: new Date().toISOString(),
        description: request,
      };
      transactions.unshift(transaction);
      return { order: transaction, card: cardView(card) };
    },
  },
};

function callTool(name, args) {
  const tool = TOOLS[name];
  if (tool === undefined) throw new Error(`Unknown tool: ${name}`);
  return tool.run(args ?? {});
}

function bearer(request) {
  const header = request.headers.authorization ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (match === null) return null;
  const record = accessTokens.get(match[1]);
  if (record === undefined) return null;
  if (record.expires_at <= Date.now()) {
    accessTokens.delete(match[1]);
    return null;
  }
  return record;
}

function platformBearer(request) {
  const header = request.headers.authorization ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (match === null) return null;
  const record = platformTokens.get(match[1]);
  if (record === undefined) return null;
  if (record.expires_at <= Date.now()) {
    platformTokens.delete(match[1]);
    return null;
  }
  return record;
}

// --- Routing ---------------------------------------------------------------

const server = createServer((request, response) => {
  void handle(request, response).catch((error) => {
    json(response, 500, { error: "server_error", error_description: String(error) });
  });
});

async function handle(request, response) {
  const url = new URL(request.url ?? "/", ORIGIN);
  const path = url.pathname;
  const method = request.method ?? "GET";

  if (path === "/.well-known/oauth-protected-resource") {
    return json(response, 200, {
      resource: `${ORIGIN}/mcp`,
      authorization_servers: [ORIGIN],
      bearer_methods_supported: ["header"],
      scopes_supported: [],
    });
  }

  if (
    path === "/.well-known/oauth-authorization-server" ||
    path === "/.well-known/openid-configuration"
  ) {
    return json(response, 200, metadata());
  }

  if (path === "/register" && method === "POST") {
    const body = JSON.parse((await readBody(request)) || "{}");
    const clientId = randomUUID();
    clients.set(clientId, {
      client_id: clientId,
      redirect_uris: body.redirect_uris ?? [],
    });
    console.log(`[agentcard-stub] registered client ${clientId} -> ${body.redirect_uris}`);
    return json(response, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: body.redirect_uris ?? [],
      grant_types: body.grant_types ?? ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_name: body.client_name,
    });
  }

  if (path === "/authorize") {
    const clientId = url.searchParams.get("client_id") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const challenge = url.searchParams.get("code_challenge") ?? "";
    const client = clients.get(clientId);

    if (client === undefined || !client.redirect_uris.includes(redirectUri)) {
      response.writeHead(400, { "content-type": "text/plain" });
      return response.end("Unknown client_id or unregistered redirect_uri");
    }

    // GET renders consent; POST is the owner clicking "Allow".
    if (method === "GET") {
      const page = authorizePage(url.searchParams);
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(page),
      });
      return response.end(page);
    }

    const code = base64url(randomBytes(24));
    codes.set(code, { client_id: clientId, redirect_uri: redirectUri, challenge });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", state);
    console.log(`[agentcard-stub] authorized -> ${back}`);
    response.writeHead(302, { location: back.toString() });
    return response.end();
  }

  if (path === "/token" && method === "POST") {
    const form = new URLSearchParams(await readBody(request));
    const grant = form.get("grant_type");
    if (TOKEN_DELAY_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, TOKEN_DELAY_MS));
    }

    if (grant === "authorization_code") {
      const code = form.get("code") ?? "";
      const record = codes.get(code);
      codes.delete(code);
      if (record === undefined) {
        return json(response, 400, { error: "invalid_grant", error_description: "unknown code" });
      }
      if (form.get("redirect_uri") !== record.redirect_uri) {
        return json(response, 400, {
          error: "invalid_grant",
          error_description: "redirect_uri mismatch",
        });
      }
      const verifier = form.get("code_verifier") ?? "";
      const computed = base64url(createHash("sha256").update(verifier).digest());
      if (computed !== record.challenge) {
        return json(response, 400, {
          error: "invalid_grant",
          error_description: "PKCE verification failed",
        });
      }
      console.log("[agentcard-stub] issued tokens (authorization_code)");
      return json(response, 200, issueTokens(record.client_id));
    }

    if (grant === "refresh_token") {
      const token = form.get("refresh_token") ?? "";
      const record = refreshTokens.get(token);
      if (record === undefined) {
        return json(response, 400, {
          error: "invalid_grant",
          error_description: "unknown refresh token",
        });
      }
      refreshTokens.delete(token);
      console.log("[agentcard-stub] issued tokens (refresh_token)");
      return json(response, 200, issueTokens(record.client_id));
    }

    return json(response, 400, { error: "unsupported_grant_type" });
  }

  // --- Connect REST API ----------------------------------------------------
  // Client-credentials platform tokens plus a one-time email/phone code.
  // Connection tokens land in the shared accessTokens map, so the MCP
  // endpoint accepts them.

  if (path === "/api/v2/oauth/token" && method === "POST") {
    const form = new URLSearchParams(await readBody(request));
    if (
      form.get("grant_type") !== "client_credentials" ||
      !form.get("client_id") ||
      !form.get("client_secret")
    ) {
      return json(response, 400, {
        error: { code: "invalid_request", message: "Client credentials are required." },
      });
    }
    const token = `plat_${base64url(randomBytes(12))}`;
    platformTokens.set(token, { expires_at: Date.now() + TOKEN_TTL_SECONDS * 1000 });
    console.log("[agentcard-stub] issued platform token (client_credentials)");
    return json(response, 200, {
      access_token: token,
      token_type: "Bearer",
      expires_in: TOKEN_TTL_SECONDS,
      scope: "api",
    });
  }

  if (path.startsWith("/api/v2/connect/")) {
    if (method !== "POST") {
      return json(response, 405, {
        error: { code: "method_not_allowed", message: "Use POST." },
      });
    }
    if (platformBearer(request) === null) {
      return json(response, 401, {
        error: { code: "unauthorized", message: "Platform token is invalid or expired." },
      });
    }
    const body = JSON.parse((await readBody(request)) || "{}");

    if (path === "/api/v2/connect/start") {
      const hasEmail = typeof body.email === "string" && body.email.length > 0;
      const hasPhone = typeof body.phone === "string" && body.phone.length > 0;
      if (hasEmail === hasPhone) {
        return json(response, 400, {
          error: {
            code: "invalid_request",
            message: "Send exactly one email or phone.",
          },
        });
      }
      const id = `ca_${base64url(randomBytes(8))}`;
      connectAttempts.set(
        id,
        hasEmail ? { email: body.email } : { phone: body.phone },
      );
      const destination = hasEmail ? body.email : body.phone;
      const channel = hasEmail ? "email" : "phone";
      console.log(`[agentcard-stub] connect code for ${destination}: ${COMPANY_CODE}`);
      return json(response, 201, {
        object: "connect_attempt",
        id,
        channel,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      });
    }

    if (path === "/api/v2/connect/verify") {
      const attempt = connectAttempts.get(body.connect_id);
      if (attempt === undefined) {
        return json(response, 400, {
          error: {
            code: "invalid_connect_attempt",
            message: "The connect attempt does not exist or has expired.",
          },
        });
      }
      if (body.code !== COMPANY_CODE) {
        return json(response, 401, {
          error: { code: "invalid_code", message: "The one-time code is invalid." },
        });
      }
      connectAttempts.delete(body.connect_id);
      if (attempt.phone !== undefined) {
        account.phone = attempt.phone;
        phoneVerifications.set("user_stub", {
          phone_number: attempt.phone,
          expires_at: Date.now() + 60 * 24 * 60 * 60_000,
        });
      }
      console.log("[agentcard-stub] issued connection tokens (connect_verify)");
      return json(response, 200, issueCompanyConnection());
    }

    if (path === "/api/v2/connect/consent") {
      if (
        typeof body.user_id !== "string" ||
        typeof body.terms_version !== "string"
      ) {
        return json(response, 400, {
          error: {
            code: "invalid_request",
            message: "user_id and terms_version are required.",
          },
        });
      }
      consents.add(body.user_id);
      return json(response, 201, {
        object: "consent",
        id: `cns_${base64url(randomBytes(6))}`,
        user_id: body.user_id,
        terms_version: body.terms_version,
        created_at: new Date().toISOString(),
      });
    }

    if (path === "/api/v2/connect/refresh") {
      if (!companyRefreshTokens.has(body.refresh_token)) {
        return json(response, 401, {
          error: {
            code: "invalid_refresh_token",
            message: "The refresh token is invalid or expired.",
          },
        });
      }
      companyRefreshTokens.delete(body.refresh_token);
      console.log("[agentcard-stub] issued connection tokens (connect_refresh)");
      return json(response, 200, issueCompanyConnection());
    }

    return json(response, 404, {
      error: { code: "not_found", message: "No such Connect endpoint." },
    });
  }

  if (
    path === "/api/v2/attach" ||
    path === "/api/v2/wallet/phone/start" ||
    path === "/api/v2/wallet/phone/verify" ||
    path === "/api/v2/wallet/fund"
  ) {
    if (platformBearer(request) === null) {
      return json(response, 401, {
        error: { code: "unauthorized", message: "Platform token is invalid or expired." },
      });
    }

    const body =
      method === "POST" ? JSON.parse((await readBody(request)) || "{}") : {};
    const userId =
      method === "GET" ? url.searchParams.get("user_id") : body.user_id;
    if (userId !== "user_stub") {
      return json(response, 404, {
        error: {
          code: "connection_not_found",
          message: "No connected user exists for that id.",
        },
      });
    }

    if (path === "/api/v2/wallet/phone/start" && method === "POST") {
      const verified = phoneVerifications.get(userId);
      if (verified !== undefined && verified.expires_at > Date.now()) {
        return json(response, 200, {
          object: "phone_verification",
          status: "already_verified",
        });
      }
      const phoneNumber =
        account.phone ??
        (typeof body.phone_number === "string" ? body.phone_number : null);
      if (phoneNumber === null) {
        return json(response, 422, {
          error: {
            code: "phone_number_required",
            message: "Provide an E.164 phone_number.",
          },
        });
      }
      if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
        return json(response, 400, {
          error: {
            code: "invalid_request",
            message: "phone_number must be E.164.",
          },
        });
      }
      phoneVerifications.set(userId, {
        phone_number: phoneNumber,
        expires_at: 0,
      });
      console.log(`[agentcard-stub] phone code for ${phoneNumber}: ${COMPANY_CODE}`);
      return json(response, 200, {
        object: "phone_verification",
        status: "sent",
        channel: "sms",
        phone: `${phoneNumber.slice(0, 2)}••••${phoneNumber.slice(-4)}`,
        expires_in_seconds: 600,
      });
    }

    if (path === "/api/v2/wallet/phone/verify" && method === "POST") {
      const pending = phoneVerifications.get(userId);
      if (
        pending === undefined ||
        body.code !== COMPANY_CODE ||
        (body.phone_number !== undefined &&
          body.phone_number !== pending.phone_number)
      ) {
        return json(response, 422, {
          error: {
            code: "invalid_code",
            message: "The phone code is incorrect or no longer active.",
            reason: pending === undefined ? "no_code" : "incorrect",
          },
        });
      }
      account.phone = pending.phone_number;
      phoneVerifications.set(userId, {
        phone_number: pending.phone_number,
        expires_at: Date.now() + 60 * 24 * 60 * 60_000,
      });
      return json(response, 200, {
        object: "phone_verification",
        status: "verified",
      });
    }

    if (path === "/api/v2/attach") {
      if (method === "GET") {
        const id = latestAttachmentByUser.get(userId);
        const attachment = id === undefined ? undefined : attachments.get(id);
        return attachment === undefined
          ? json(response, 404, {
              error: {
                code: "no_attachment",
                message: "No card attachment has been started.",
              },
            })
          : json(response, 200, {
              object: "card_attachment",
              ...attachment,
            });
      }
      if (method !== "POST") {
        return json(response, 405, {
          error: { code: "method_not_allowed", message: "Use GET or POST." },
        });
      }
      const verified = phoneVerifications.get(userId);
      const missingFields = [];
      if (verified === undefined || verified.expires_at <= Date.now()) {
        missingFields.push("phone_number");
      }
      if (!consents.has(userId)) missingFields.push("consent");
      if (missingFields.length > 0) {
        return json(response, 422, {
          error: {
            code: "user_info_required",
            message: "Verify a phone number and record consent first.",
            missing_fields: missingFields,
          },
        });
      }
      const currentId = latestAttachmentByUser.get(userId);
      const current =
        currentId === undefined ? undefined : attachments.get(currentId);
      if (current?.status === "active") {
        return json(response, 200, {
          object: "card_attachment",
          ...current,
        });
      }
      const id = `att_${base64url(randomBytes(8))}`;
      const attachment = {
        id,
        user_id: userId,
        status: "pending",
        attach_url: `${ORIGIN}/attach/${id}`,
        expires_at: new Date(Date.now() + 48 * 60 * 60_000).toISOString(),
      };
      attachments.set(id, attachment);
      latestAttachmentByUser.set(userId, id);
      return json(response, 201, {
        object: "card_attachment",
        ...attachment,
      });
    }

    if (path === "/api/v2/wallet/fund" && method === "POST") {
      const verified = phoneVerifications.get(userId);
      if (verified === undefined || verified.expires_at <= Date.now()) {
        return json(response, 422, {
          error: {
            code: "phone_verification_required",
            message: "Verify the user's phone before funding.",
          },
        });
      }
      if (!Number.isSafeInteger(body.amount_cents) || body.amount_cents <= 0) {
        return json(response, 400, {
          error: {
            code: "invalid_request",
            message: "amount_cents must be a positive integer.",
          },
        });
      }
      const fundingId = `fund_${base64url(randomBytes(8))}`;
      return json(response, 201, {
        object: "funding_session",
        id: fundingId,
        user_id: userId,
        status: "pending",
        amount_cents: body.amount_cents,
        currency: "USD",
        payment_method:
          body.payment_method === "google_pay" ? "google_pay" : "apple_pay",
        checkout_url: `${ORIGIN}/checkout/${fundingId}?amount_cents=${body.amount_cents}`,
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      });
    }
  }

  if (path === "/mcp") {
    if (method !== "POST") {
      return json(response, 405, { error: "method_not_allowed" });
    }
    const accept = request.headers.accept ?? "";
    if (
      !accept.includes("application/json") ||
      !accept.includes("text/event-stream")
    ) {
      return json(response, 406, {
        error:
          "MCP Streamable HTTP requires Accept: application/json, text/event-stream",
      });
    }
    if (bearer(request) === null) {
      return json(
        response,
        401,
        { error: "Missing Authorization: Bearer <token> header" },
        {
          "www-authenticate": `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`,
        },
      );
    }

    const message = JSON.parse((await readBody(request)) || "{}");
    const { id, method: rpc, params } = message;
    const sessionId = "stub-session";
    if (
      rpc !== "initialize" &&
      request.headers["mcp-session-id"] !== sessionId
    ) {
      return json(response, 400, {
        error: "Missing or incorrect Mcp-Session-Id",
      });
    }

    // Notifications carry no id and expect no body.
    if (id === undefined) {
      response.writeHead(202);
      return response.end();
    }

    const headers = { "mcp-session-id": sessionId };

    if (rpc === "initialize") {
      return json(
        response,
        200,
        {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "agentcard-stub", version: "1.0.0" },
          },
        },
        headers,
      );
    }

    if (rpc === "tools/list") {
      return json(
        response,
        200,
        {
          jsonrpc: "2.0",
          id,
          result: {
            tools: Object.entries(TOOLS).map(([name, tool]) => ({
              name,
              description: tool.description,
              inputSchema: tool.schema,
            })),
          },
        },
        headers,
      );
    }

    if (rpc === "tools/call") {
      const name = params?.name;
      // Tool arguments may grow to include credentials in future server
      // versions. Log the operation name only, never argument values.
      console.log(`[agentcard-stub] tools/call ${name}`);
      try {
        const result = callTool(name, params?.arguments);
        return json(
          response,
          200,
          {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: JSON.stringify(result) }] },
          },
          headers,
        );
      } catch (error) {
        return json(
          response,
          200,
          {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }],
            },
          },
          headers,
        );
      }
    }

    return json(
      response,
      200,
      { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${rpc}` } },
      headers,
    );
  }

  if (path.startsWith("/attach/")) {
    const id = path.slice("/attach/".length);
    const attachment = attachments.get(id);
    if (attachment === undefined) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return response.end("Attachment not found");
    }
    if (method === "POST") {
      const ineligible = process.env.STUB_ATTACH_OUTCOME === "ineligible";
      const completed = ineligible
        ? {
            ...attachment,
            status: "ineligible",
            reason: "issuer_excluded",
            message: "This test issuer does not support card attachment.",
          }
        : {
            ...attachment,
            status: "active",
            card: { brand: "Visa", last4: "4242" },
          };
      delete completed.attach_url;
      delete completed.expires_at;
      attachments.set(id, completed);
      const page = `<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:40px">
        <h1>${ineligible ? "Card not eligible" : "Test Visa attached"}</h1>
        <p>Return to Ruth and say you finished so she can check the attachment.</p></body>`;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return response.end(page);
    }
    const page = `<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:40px;max-width:560px">
      <h1>Attach a test Visa</h1>
      <p>Local Agentcard stub. In production, card details, the bank one-time code, and a passkey are handled only on Agentcard's hosted page. This stub never asks for real card details.</p>
      <form method="POST"><button style="padding:10px 18px;font-size:15px">Complete test attachment</button></form></body>`;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return response.end(page);
  }

  if (path.startsWith("/checkout/")) {
    const amount = Number.parseInt(url.searchParams.get("amount_cents") ?? "0", 10);
    if (method === "POST") {
      account.balance_cents += amount;
      const page = `<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:40px">
        <h1>Paid</h1><p>$${(amount / 100).toFixed(2)} added. Balance is now $${(account.balance_cents / 100).toFixed(2)}.</p></body>`;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return response.end(page);
    }
    const page = `<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:40px">
      <h1>Add $${(amount / 100).toFixed(2)}</h1>
      <p>Stub checkout — stands in for Apple Pay / Google Pay.</p>
      <form method="POST"><button style="padding:10px 18px;font-size:15px">Pay now</button></form></body>`;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return response.end(page);
  }

  json(response, 404, { error: "not_found", path });
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[agentcard-stub] listening on ${ORIGIN}`);
  console.log(`[agentcard-stub] AGENTCARD_MCP_URL=${ORIGIN}/mcp npm run dev`);
});
