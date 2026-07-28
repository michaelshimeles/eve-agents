// A local stand-in for Agentcard, for exercising the payment capability
// without an Agentcard account (which needs a real email, phone, and card).
// Speaks the two surfaces the app touches, in the shapes the real service
// answers with: the OAuth 2.1 authorization server that fronts
// mcp.agentcard.sh (discovery documents, dynamic client registration, PKCE
// authorization code, refresh) and the MCP server itself over Streamable HTTP.
//
//   node scripts/agentcard-stub.mjs                     # 127.0.0.1:4546
//   AGENTCARD_MCP_URL=http://127.0.0.1:4546/mcp npm run dev
//
// The /authorize page is a real consent screen: it renders a button, and only
// on submit does it redirect back with a code, so the browser round trip is
// exercised the way the real one is. Money is simulated - a balance you can
// top up, cards that deduct from it, single-use cards that close after their
// first charge - so create_card, get_card_details, and the approval gates all
// run against something with state.
//
// STUB_TOKEN_TTL_SECONDS shortens access-token lifetime (default 3600) to
// exercise the refresh path. STUB_TOKEN_DELAY_MS holds every /token response
// for that long, widening the window for exercising concurrent refreshes
// (refresh tokens rotate on use here, like the real service).

import { createHash, randomUUID, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number.parseInt(process.env.PORT ?? "4546", 10);
const ORIGIN = process.env.STUB_ORIGIN ?? `http://127.0.0.1:${PORT}`;
const TOKEN_TTL_SECONDS = Number.parseInt(process.env.STUB_TOKEN_TTL_SECONDS ?? "3600", 10);
const TOKEN_DELAY_MS = Number.parseInt(process.env.STUB_TOKEN_DELAY_MS ?? "0", 10);

/** @type {Map<string, {client_id: string, redirect_uris: string[]}>} */
const clients = new Map();
/** @type {Map<string, {client_id: string, redirect_uri: string, challenge: string}>} */
const codes = new Map();
/** @type {Map<string, {client_id: string, expires_at: number}>} */
const accessTokens = new Map();
/** @type {Map<string, {client_id: string}>} */
const refreshTokens = new Map();

const account = {
  email: "owner@example.com",
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
    run: ({ amount_cents: amount, type }) => ({
      card: cardView(createCard(amount, type)),
      balance_cents: account.balance_cents,
    }),
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
    run: ({ card_id: cardId }) => ({ card: cardView(requireCard(cardId), true) }),
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

  if (path === "/mcp") {
    if (method !== "POST") {
      return json(response, 405, { error: "method_not_allowed" });
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

    // Notifications carry no id and expect no body.
    if (id === undefined) {
      response.writeHead(202);
      return response.end();
    }

    const headers = { "mcp-session-id": "stub-session" };

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
      console.log(`[agentcard-stub] tools/call ${name} ${JSON.stringify(params?.arguments ?? {})}`);
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
