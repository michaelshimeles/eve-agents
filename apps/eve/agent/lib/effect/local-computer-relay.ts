import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

import { Context, Data, Effect, Layer, Schema } from "effect";
import type { SchemaError } from "effect/SchemaError";

import { type DatabaseError, Db } from "./db";

const PAIR_TICKET_TTL_MINUTES = 10;
const RELAY_REQUEST_TTL_SECONDS = 300;
const ONLINE_WINDOW_SECONDS = 25;
const POLL_INTERVAL = "250 millis";

const SHA256 = /^[a-f0-9]{64}$/;

export class LocalComputerRelayError extends Data.TaggedError("LocalComputerRelayError")<{
  readonly reason:
    | "not_configured"
    | "not_paired"
    | "unauthorized"
    | "invalid"
    | "expired"
    | "not_found"
    | "timeout";
  readonly detail: string;
}> {}

export function describeLocalComputerRelayError(error: LocalComputerRelayError): string {
  switch (error.reason) {
    case "not_configured":
      return `Ruth Local relay is not configured: ${error.detail}`;
    case "not_paired":
      return `Ruth Local is not paired: ${error.detail}`;
    case "unauthorized":
      return `Ruth Local relay authorization failed: ${error.detail}`;
    case "invalid":
      return `Ruth Local relay refused invalid data: ${error.detail}`;
    case "expired":
      return `Ruth Local pairing expired: ${error.detail}`;
    case "not_found":
      return `Ruth Local relay request was not found: ${error.detail}`;
    case "timeout":
      return `Ruth Local is offline: ${error.detail}`;
  }
}

export type LocalComputerRelayStoreError =
  | LocalComputerRelayError
  | DatabaseError
  | SchemaError;

const DeviceRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  platform: Schema.String,
  architecture: Schema.String,
  pairedAt: Schema.String,
  lastSeenAt: Schema.NullOr(Schema.String),
  online: Schema.Boolean,
});
type DeviceRow = typeof DeviceRow.Type;

const AgentCredentialRow = Schema.Struct({
  id: Schema.String,
  agentNonce: Schema.NullOr(Schema.String),
});

const AuthorizedDeviceRow = Schema.Struct({
  id: Schema.String,
});

const RelayRequestRow = Schema.Struct({
  id: Schema.String,
  method: Schema.String,
  headers: Schema.Unknown,
  body: Schema.NullOr(Schema.String),
});

const RelayResponseRow = Schema.Struct({
  status: Schema.Int,
  headers: Schema.Unknown,
  body: Schema.String,
});

const RelayCompletionRow = Schema.Struct({
  status: Schema.String,
});

export interface LocalComputerStatus {
  readonly databaseConfigured: boolean;
  readonly device: DeviceRow | null;
}

export interface LocalComputerPairTicket {
  readonly id: string;
  readonly secret: string;
  readonly expiresAt: string;
}

export interface EnrollLocalComputerInput {
  readonly ticketId: string;
  readonly ticketSecret: string;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly deviceTokenHash: string;
  readonly platform: string;
  readonly architecture: string;
}

export interface RelayRequest {
  readonly id: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

export interface RelayResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface EnqueueRelayRequestInput {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

function databaseConfigured(): boolean {
  return (process.env.DATABASE_URL ?? "").trim().length > 0;
}

export function hashLocalComputerSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function relayCredentialKey(): string {
  return process.env.RUTH_LOCAL_RELAY_SECRET?.trim() || process.env.DATABASE_URL!;
}

function deriveAgentToken(deviceId: string, nonce: string): string {
  return createHmac("sha256", relayCredentialKey())
    .update(`ruth-local-agent:v1:${deviceId}:${nonce}`, "utf8")
    .digest("base64url");
}

function validIdentifier(value: string): boolean {
  return /^[a-zA-Z0-9._:-]{8,200}$/.test(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, item]) =>
      typeof item === "string" ? [[name, item] as const] : [],
    ),
  );
}

export class LocalComputerRelay extends Context.Service<
  LocalComputerRelay,
  {
    readonly status: () => Effect.Effect<
      LocalComputerStatus,
      LocalComputerRelayStoreError
    >;
    readonly createPairTicket: () => Effect.Effect<
      LocalComputerPairTicket,
      LocalComputerRelayStoreError
    >;
    readonly enroll: (
      input: EnrollLocalComputerInput,
    ) => Effect.Effect<DeviceRow, LocalComputerRelayStoreError>;
    readonly disconnect: () => Effect.Effect<void, LocalComputerRelayStoreError>;
    readonly agentCredential: () => Effect.Effect<
      { readonly deviceId: string; readonly token: string },
      LocalComputerRelayStoreError
    >;
    readonly authorizeAgent: (
      token: string,
    ) => Effect.Effect<string, LocalComputerRelayStoreError>;
    readonly authorizeDevice: (
      token: string,
    ) => Effect.Effect<string, LocalComputerRelayStoreError>;
    readonly poll: (
      deviceId: string,
    ) => Effect.Effect<RelayRequest | null, LocalComputerRelayStoreError>;
    readonly complete: (
      deviceId: string,
      requestId: string,
      response: RelayResponse,
    ) => Effect.Effect<void, LocalComputerRelayStoreError>;
    readonly enqueue: (
      deviceId: string,
      input: EnqueueRelayRequestInput,
    ) => Effect.Effect<string, LocalComputerRelayStoreError>;
    readonly awaitResponse: (
      requestId: string,
      timeoutMs: number,
    ) => Effect.Effect<RelayResponse, LocalComputerRelayStoreError>;
  }
>()("LocalComputerRelay") {}

export const LocalComputerRelayLive = Layer.effect(
  LocalComputerRelay,
  Effect.gen(function* () {
    const database = yield* Db;
    let ensured = false;
    const decodeDevices = Schema.decodeUnknownEffect(Schema.Array(DeviceRow));
    const decodeCredentials = Schema.decodeUnknownEffect(
      Schema.Array(AgentCredentialRow),
    );
    const decodeAuthorizedDevices = Schema.decodeUnknownEffect(
      Schema.Array(AuthorizedDeviceRow),
    );
    const decodeRequests = Schema.decodeUnknownEffect(
      Schema.Array(RelayRequestRow),
    );
    const decodeResponses = Schema.decodeUnknownEffect(
      Schema.Array(RelayResponseRow),
    );
    const decodeCompletions = Schema.decodeUnknownEffect(
      Schema.Array(RelayCompletionRow),
    );

    const ensure = Effect.gen(function* () {
      if (!databaseConfigured()) {
        return yield* Effect.fail(
          new LocalComputerRelayError({
            reason: "not_configured",
            detail: "DATABASE_URL is required for one-click pairing.",
          }),
        );
      }
      const explicitRelaySecret = process.env.RUTH_LOCAL_RELAY_SECRET?.trim();
      if (
        explicitRelaySecret !== undefined &&
        explicitRelaySecret.length > 0 &&
        explicitRelaySecret.length < 32
      ) {
        return yield* Effect.fail(
          new LocalComputerRelayError({
            reason: "not_configured",
            detail: "RUTH_LOCAL_RELAY_SECRET must contain at least 32 characters.",
          }),
        );
      }
      if (ensured) return;
      yield* database.query(`
        CREATE TABLE IF NOT EXISTS local_computer_pair_tickets (
          id uuid PRIMARY KEY,
          secret_hash text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          expires_at timestamptz NOT NULL,
          used_at timestamptz
        )
      `);
      yield* database.query(`
        CREATE TABLE IF NOT EXISTS local_computer_devices (
          id text PRIMARY KEY,
          name text NOT NULL,
          platform text NOT NULL,
          architecture text NOT NULL,
          token_hash text NOT NULL,
          agent_token text NOT NULL,
          active boolean NOT NULL DEFAULT true,
          paired_at timestamptz NOT NULL DEFAULT now(),
          last_seen_at timestamptz,
          revoked_at timestamptz
        )
      `);
      yield* database.query(
        "ALTER TABLE local_computer_devices ADD COLUMN IF NOT EXISTS agent_nonce text",
      );
      // Pairing is a single SQL statement that disables the old device before
      // activating the new one. Keep this a lookup index rather than a unique
      // boolean index: PostgreSQL data-changing CTEs share a snapshot, so a
      // uniqueness check could race the sibling UPDATE inside that statement.
      yield* database.query(
        "DROP INDEX IF EXISTS local_computer_one_active_idx",
      );
      yield* database.query(
        "CREATE INDEX IF NOT EXISTS local_computer_active_idx ON local_computer_devices (paired_at DESC) WHERE active",
      );
      yield* database.query(
        "CREATE INDEX IF NOT EXISTS local_computer_device_token_idx ON local_computer_devices (token_hash) WHERE active",
      );
      yield* database.query(`
        CREATE TABLE IF NOT EXISTS local_computer_relay_requests (
          id uuid PRIMARY KEY,
          device_id text NOT NULL REFERENCES local_computer_devices(id),
          method text NOT NULL,
          request_headers jsonb NOT NULL DEFAULT '{}'::jsonb,
          request_body text,
          status text NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'claimed', 'completed', 'cancelled')),
          response_status integer,
          response_headers jsonb,
          response_body text,
          created_at timestamptz NOT NULL DEFAULT now(),
          expires_at timestamptz NOT NULL,
          claimed_at timestamptz,
          completed_at timestamptz
        )
      `);
      yield* database.query(
        "CREATE INDEX IF NOT EXISTS local_computer_relay_pending_idx ON local_computer_relay_requests (device_id, created_at) WHERE status = 'pending'",
      );
      ensured = true;
    });

    const activeDeviceProjection = `
      id,
      name,
      platform,
      architecture,
      paired_at::text AS "pairedAt",
      last_seen_at::text AS "lastSeenAt",
      COALESCE(last_seen_at > now() - interval '${ONLINE_WINDOW_SECONDS} seconds', false) AS online
    `;

    const status = () =>
      Effect.gen(function* () {
        if (!databaseConfigured()) {
          return { databaseConfigured: false, device: null };
        }
        yield* ensure;
        const rows = yield* database.query(
          `SELECT ${activeDeviceProjection}
             FROM local_computer_devices
            WHERE active
            ORDER BY paired_at DESC
            LIMIT 1`,
        );
        const device = (yield* decodeDevices(rows))[0] ?? null;
        return { databaseConfigured: true, device };
      });

    const createPairTicket = () =>
      Effect.gen(function* () {
        yield* ensure;
        const id = randomUUID();
        const secret = randomBytes(32).toString("base64url");
        const secretHash = hashLocalComputerSecret(secret);
        const rows = yield* database.query(
          `INSERT INTO local_computer_pair_tickets (id, secret_hash, expires_at)
           VALUES ($1, $2, now() + interval '${PAIR_TICKET_TTL_MINUTES} minutes')
           RETURNING expires_at::text AS "expiresAt"`,
          [id, secretHash],
        );
        const expiresAt = rows[0]?.expiresAt;
        if (typeof expiresAt !== "string") {
          return yield* Effect.fail(
            new LocalComputerRelayError({
              reason: "invalid",
              detail: "could not create a pairing ticket.",
            }),
          );
        }
        yield* database.query(
          `DELETE FROM local_computer_pair_tickets
            WHERE expires_at < now() - interval '1 day'
               OR used_at < now() - interval '1 day'`,
        );
        return { id, secret, expiresAt };
      });

    const enroll = (input: EnrollLocalComputerInput) =>
      Effect.gen(function* () {
        yield* ensure;
        if (
          !validIdentifier(input.deviceId) ||
          input.deviceName.trim().length === 0 ||
          input.deviceName.length > 200 ||
          input.platform !== "darwin" ||
          !["arm64", "x64"].includes(input.architecture) ||
          !SHA256.test(input.deviceTokenHash)
        ) {
          return yield* Effect.fail(
            new LocalComputerRelayError({
              reason: "invalid",
              detail: "the enrollment payload is malformed.",
            }),
          );
        }
        const agentNonce = randomBytes(32).toString("base64url");
        const agentToken = deriveAgentToken(input.deviceId, agentNonce);
        const rows = yield* database.query(
          `WITH locked AS (
             SELECT pg_advisory_xact_lock(782031142770336083::bigint)
           ),
           claimed AS (
             UPDATE local_computer_pair_tickets
                SET used_at = now()
              WHERE id = $1::uuid
                AND secret_hash = $2
                AND used_at IS NULL
                AND expires_at > now()
                AND EXISTS (SELECT 1 FROM locked)
              RETURNING id
           ),
           disabled AS (
             UPDATE local_computer_devices
                SET active = false, revoked_at = now()
              WHERE active
                AND EXISTS (SELECT 1 FROM claimed)
             RETURNING id
           ),
           synchronized AS (
             SELECT count(*) FROM disabled
           ),
           paired AS (
             INSERT INTO local_computer_devices (
               id, name, platform, architecture, token_hash, agent_token,
               agent_nonce, active, paired_at, last_seen_at, revoked_at
             )
             SELECT $3, $4, $5, $6, $7, $8, $9, true, now(), now(), NULL
               FROM claimed CROSS JOIN synchronized
             ON CONFLICT (id) DO UPDATE
               SET name = EXCLUDED.name,
                   platform = EXCLUDED.platform,
                   architecture = EXCLUDED.architecture,
                   token_hash = EXCLUDED.token_hash,
                   agent_token = EXCLUDED.agent_token,
                   agent_nonce = EXCLUDED.agent_nonce,
                   active = true,
                   paired_at = now(),
                   last_seen_at = now(),
                   revoked_at = NULL
             RETURNING id,
                       name,
                       platform,
                       architecture,
                       paired_at::text AS "pairedAt",
                       last_seen_at::text AS "lastSeenAt",
                       true AS online
           )
           SELECT * FROM paired`,
          [
            input.ticketId,
            hashLocalComputerSecret(input.ticketSecret),
            input.deviceId,
            input.deviceName.trim(),
            input.platform,
            input.architecture,
            input.deviceTokenHash,
            hashLocalComputerSecret(agentToken),
            agentNonce,
          ],
        );
        const device = (yield* decodeDevices(rows))[0];
        if (device === undefined) {
          return yield* Effect.fail(
            new LocalComputerRelayError({
              reason: "expired",
              detail: "request another connection from Manage -> Computer.",
            }),
          );
        }
        return device;
      });

    const disconnect = () =>
      Effect.gen(function* () {
        yield* ensure;
        yield* database.query(
          `UPDATE local_computer_devices
              SET active = false, revoked_at = now()
            WHERE active`,
        );
        yield* database.query(
          `UPDATE local_computer_relay_requests
              SET status = 'cancelled'
            WHERE status IN ('pending', 'claimed')`,
        );
      });

    const agentCredential = () =>
      Effect.gen(function* () {
        yield* ensure;
        const rows = yield* database.query(
          `SELECT id, agent_nonce AS "agentNonce"
             FROM local_computer_devices
            WHERE active
            ORDER BY paired_at DESC
            LIMIT 1`,
        );
        const credential = (yield* decodeCredentials(rows))[0];
        if (credential === undefined) {
          return yield* Effect.fail(
            new LocalComputerRelayError({
              reason: "not_paired",
              detail: "download and connect Ruth Local under Manage -> Computer.",
            }),
          );
        }
        const nonce =
          credential.agentNonce ?? randomBytes(32).toString("base64url");
        const token = deriveAgentToken(credential.id, nonce);
        yield* database.query(
          `UPDATE local_computer_devices
              SET agent_nonce = $2,
                  agent_token = $3
            WHERE id = $1
              AND active`,
          [credential.id, nonce, hashLocalComputerSecret(token)],
        );
        return { deviceId: credential.id, token };
      });

    const authorizeAgent = (token: string) =>
      Effect.gen(function* () {
        yield* ensure;
        if (token.length < 32) {
          return yield* Effect.fail(
            new LocalComputerRelayError({
              reason: "unauthorized",
              detail: "missing agent relay token.",
            }),
          );
        }
        const rows = yield* database.query(
          `SELECT id
             FROM local_computer_devices
            WHERE active
              AND agent_token = $1
            LIMIT 1`,
          [hashLocalComputerSecret(token)],
        );
        const device = (yield* decodeAuthorizedDevices(rows))[0];
        if (device === undefined) {
          return yield* Effect.fail(
            new LocalComputerRelayError({
              reason: "unauthorized",
              detail: "agent relay token is not active.",
            }),
          );
        }
        return device.id;
      });

    const authorizeDevice = (token: string) =>
      Effect.gen(function* () {
        yield* ensure;
        if (token.length < 32) {
          return yield* Effect.fail(
            new LocalComputerRelayError({
              reason: "unauthorized",
              detail: "missing device token.",
            }),
          );
        }
        const rows = yield* database.query(
          `UPDATE local_computer_devices
              SET last_seen_at = now()
            WHERE active
              AND token_hash = $1
          RETURNING id`,
          [hashLocalComputerSecret(token)],
        );
        const device = (yield* decodeAuthorizedDevices(rows))[0];
        if (device === undefined) {
          return yield* Effect.fail(
            new LocalComputerRelayError({
              reason: "unauthorized",
              detail: "device token is not active.",
            }),
          );
        }
        return device.id;
      });

    const poll = (deviceId: string) =>
      Effect.gen(function* () {
        yield* ensure;
        const rows = yield* database.query(
          `WITH next_request AS (
             SELECT id
               FROM local_computer_relay_requests
              WHERE device_id = $1
                AND status = 'pending'
                AND expires_at > now()
              ORDER BY created_at
              FOR UPDATE SKIP LOCKED
              LIMIT 1
           )
           UPDATE local_computer_relay_requests request
              SET status = 'claimed', claimed_at = now()
            WHERE request.id IN (SELECT id FROM next_request)
          RETURNING request.id,
                    request.method,
                    request.request_headers AS headers,
                    request.request_body AS body`,
          [deviceId],
        );
        const request = (yield* decodeRequests(rows))[0];
        if (request === undefined) return null;
        return {
          id: request.id,
          method: request.method,
          headers: stringRecord(request.headers),
          body: request.body,
        };
      });

    const complete = (
      deviceId: string,
      requestId: string,
      response: RelayResponse,
    ) =>
      Effect.gen(function* () {
        yield* ensure;
        if (
          !Number.isSafeInteger(response.status) ||
          response.status < 100 ||
          response.status > 599 ||
          response.body.length > 16 * 1024 * 1024
        ) {
          return yield* Effect.fail(
            new LocalComputerRelayError({
              reason: "invalid",
              detail: "the local response is too large or malformed.",
            }),
          );
        }
        const rows = yield* database.query(
          `WITH completed AS (
             UPDATE local_computer_relay_requests
                SET status = 'completed',
                    response_status = $3,
                    response_headers = $4::jsonb,
                    response_body = $5,
                    completed_at = now()
              WHERE id = $1::uuid
                AND device_id = $2
                AND status = 'claimed'
            RETURNING status
           )
           SELECT status FROM completed
           UNION ALL
           SELECT request.status
             FROM local_computer_relay_requests request
            WHERE request.id = $1::uuid
              AND request.device_id = $2
              AND NOT EXISTS (SELECT 1 FROM completed)
            LIMIT 1`,
          [
            requestId,
            deviceId,
            response.status,
            JSON.stringify(response.headers),
            response.body,
          ],
        );
        const completion = (yield* decodeCompletions(rows))[0];
        if (completion === undefined) {
          return yield* Effect.fail(
            new LocalComputerRelayError({
              reason: "not_found",
              detail: "the request was already delivered or does not exist.",
            }),
          );
        }
        if (completion.status === "cancelled") {
          return yield* Effect.fail(
            new LocalComputerRelayError({
              reason: "expired",
              detail: "the active request wait was cancelled before completion.",
            }),
          );
        }
        if (completion.status !== "completed") {
          return yield* Effect.fail(
            new LocalComputerRelayError({
              reason: "invalid",
              detail: `the request cannot be completed from ${completion.status}.`,
            }),
          );
        }
      });

    const enqueue = (deviceId: string, input: EnqueueRelayRequestInput) =>
      Effect.gen(function* () {
        yield* ensure;
        if (
          !["GET", "POST", "DELETE"].includes(input.method) ||
          (input.body?.length ?? 0) > 16 * 1024 * 1024
        ) {
          return yield* Effect.fail(
            new LocalComputerRelayError({
              reason: "invalid",
              detail: "the MCP request is too large or uses an unsupported method.",
            }),
          );
        }
        const id = randomUUID();
        yield* database.query(
          `INSERT INTO local_computer_relay_requests (
             id, device_id, method, request_headers, request_body, expires_at
           )
           VALUES (
             $1::uuid, $2, $3, $4::jsonb, $5,
             now() + interval '${RELAY_REQUEST_TTL_SECONDS} seconds'
           )`,
          [id, deviceId, input.method, JSON.stringify(input.headers), input.body],
        );
        yield* database.query(
          `DELETE FROM local_computer_relay_requests
            WHERE expires_at < now() - interval '1 day'
               OR (
                 status IN ('completed', 'cancelled')
                 AND created_at < now() - interval '1 day'
               )`,
        );
        return id;
      });

    const awaitResponse = (requestId: string, timeoutMs: number) =>
      Effect.gen(function* () {
        yield* ensure;
        const deadline = Date.now() + timeoutMs;
        const consumeCompletedResponse = Effect.gen(function* () {
          const rows = yield* database.query(
            `SELECT response_status AS status,
                    response_headers AS headers,
                    response_body AS body
               FROM local_computer_relay_requests
              WHERE id = $1::uuid
                AND status = 'completed'
              LIMIT 1`,
            [requestId],
          );
          const response = (yield* decodeResponses(rows))[0];
          if (response === undefined) return null;
          yield* database.query(
            `DELETE FROM local_computer_relay_requests WHERE id = $1::uuid`,
            [requestId],
          );
          return {
            status: response.status,
            headers: stringRecord(response.headers),
            body: response.body,
          };
        });
        while (Date.now() < deadline) {
          const response = yield* consumeCompletedResponse;
          if (response !== null) return response;
          yield* Effect.sleep(POLL_INTERVAL);
        }
        yield* database.query(
          `UPDATE local_computer_relay_requests
              SET status = 'cancelled'
            WHERE id = $1::uuid
              AND status IN ('pending', 'claimed')`,
          [requestId],
        );
        // A completion can win the row lock at the deadline. Consume it once
        // more after the cancellation attempt so that successful work is not
        // reported as timed out.
        const response = yield* consumeCompletedResponse;
        if (response !== null) return response;
        return yield* Effect.fail(
          new LocalComputerRelayError({
            reason: "timeout",
            detail: "the Mac did not answer before the request expired.",
          }),
        );
      });

    return {
      status,
      createPairTicket,
      enroll,
      disconnect,
      agentCredential,
      authorizeAgent,
      authorizeDevice,
      poll,
      complete,
      enqueue,
      awaitResponse,
    };
  }),
);

export const localComputerRelayStatus = (): Effect.Effect<
  LocalComputerStatus,
  LocalComputerRelayStoreError,
  LocalComputerRelay
> =>
  Effect.gen(function* () {
    return yield* (yield* LocalComputerRelay).status();
  });

export const createLocalComputerPairTicket = (): Effect.Effect<
  LocalComputerPairTicket,
  LocalComputerRelayStoreError,
  LocalComputerRelay
> =>
  Effect.gen(function* () {
    return yield* (yield* LocalComputerRelay).createPairTicket();
  });

export const enrollLocalComputer = (
  input: EnrollLocalComputerInput,
): Effect.Effect<DeviceRow, LocalComputerRelayStoreError, LocalComputerRelay> =>
  Effect.gen(function* () {
    return yield* (yield* LocalComputerRelay).enroll(input);
  });

export const disconnectLocalComputer = (): Effect.Effect<
  void,
  LocalComputerRelayStoreError,
  LocalComputerRelay
> =>
  Effect.gen(function* () {
    return yield* (yield* LocalComputerRelay).disconnect();
  });

export const localComputerAgentCredential = (): Effect.Effect<
  { readonly deviceId: string; readonly token: string },
  LocalComputerRelayStoreError,
  LocalComputerRelay
> =>
  Effect.gen(function* () {
    return yield* (yield* LocalComputerRelay).agentCredential();
  });

export const authorizeLocalComputerAgent = (
  token: string,
): Effect.Effect<string, LocalComputerRelayStoreError, LocalComputerRelay> =>
  Effect.gen(function* () {
    return yield* (yield* LocalComputerRelay).authorizeAgent(token);
  });

export const authorizeLocalComputerDevice = (
  token: string,
): Effect.Effect<string, LocalComputerRelayStoreError, LocalComputerRelay> =>
  Effect.gen(function* () {
    return yield* (yield* LocalComputerRelay).authorizeDevice(token);
  });

export const pollLocalComputerRelay = (
  deviceId: string,
): Effect.Effect<RelayRequest | null, LocalComputerRelayStoreError, LocalComputerRelay> =>
  Effect.gen(function* () {
    return yield* (yield* LocalComputerRelay).poll(deviceId);
  });

export const completeLocalComputerRelay = (
  deviceId: string,
  requestId: string,
  response: RelayResponse,
): Effect.Effect<void, LocalComputerRelayStoreError, LocalComputerRelay> =>
  Effect.gen(function* () {
    return yield* (yield* LocalComputerRelay).complete(
      deviceId,
      requestId,
      response,
    );
  });

export const enqueueLocalComputerRelay = (
  deviceId: string,
  input: EnqueueRelayRequestInput,
): Effect.Effect<string, LocalComputerRelayStoreError, LocalComputerRelay> =>
  Effect.gen(function* () {
    return yield* (yield* LocalComputerRelay).enqueue(deviceId, input);
  });

export const awaitLocalComputerRelayResponse = (
  requestId: string,
  timeoutMs: number,
): Effect.Effect<RelayResponse, LocalComputerRelayStoreError, LocalComputerRelay> =>
  Effect.gen(function* () {
    return yield* (yield* LocalComputerRelay).awaitResponse(
      requestId,
      timeoutMs,
    );
  });
