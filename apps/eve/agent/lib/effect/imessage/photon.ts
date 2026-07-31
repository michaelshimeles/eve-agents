import { Effect } from "effect";

import { IMessageError } from "../imessage";
import { synthesizeIMessageSpeech } from "./media";
import { fetchPublicMedia } from "./security";
import type { IMessageCommand } from "./schema";

type PhotonTarget =
  | { readonly kind: "dm"; readonly handle: string }
  | { readonly kind: "space"; readonly spaceId: string };

interface PhotonSendResult {
  readonly providerMessageId?: string;
  readonly result?: Readonly<Record<string, unknown>>;
}

async function executeStubPhotonCommand(
  command: IMessageCommand,
): Promise<PhotonSendResult | null> {
  const base = env("SPECTRUM_API_BASE_URL");
  if (base === null) return null;
  const response = await fetch(`${base.replace(/\/+$/, "")}/v1/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json().catch(() => null)) as
    | {
        providerMessageId?: unknown;
        result?: unknown;
        error?: unknown;
      }
    | null;
  if (!response.ok) {
    throw new Error(
      typeof body?.error === "string"
        ? body.error
        : `Spectrum stub returned HTTP ${response.status}`,
    );
  }
  return {
    ...(typeof body?.providerMessageId === "string"
      ? { providerMessageId: body.providerMessageId }
      : {}),
    ...(body?.result !== null &&
    typeof body?.result === "object" &&
    !Array.isArray(body.result)
      ? { result: body.result as Readonly<Record<string, unknown>> }
      : {}),
  };
}

interface RichPhotonOps {
  readonly execute: (
    command: IMessageCommand,
    ownerHandle: string,
  ) => Promise<PhotonSendResult | null>;
}

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value !== undefined && value.length > 0 ? value : null;
}

function line(phone: string): string | null {
  return phone.length > 0 && phone !== "shared"
    ? phone
    : env("SPECTRUM_LINE_PHONE");
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown, key: string): string {
  const field = record(value)[key];
  return typeof field === "string" ? field : "";
}

function stringArray(value: unknown, key: string): readonly string[] {
  const field = record(value)[key];
  return Array.isArray(field)
    ? field.filter((item): item is string => typeof item === "string")
    : [];
}

function numberField(value: unknown, key: string): number | undefined {
  const field = record(value)[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function boolField(value: unknown, key: string): boolean {
  return record(value)[key] === true;
}

function vcardEscape(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
}

function structuredVCard(payload: Record<string, unknown>): string | null {
  const name = stringField(payload, "name").trim();
  const phones = stringArray(payload, "phones");
  const emails = stringArray(payload, "emails");
  if (name.length === 0 && phones.length === 0 && emails.length === 0) return null;
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${vcardEscape(name || "Ruth contact")}`,
    ...phones.map((phone) => `TEL:${vcardEscape(phone)}`),
    ...emails.map((email) => `EMAIL:${vcardEscape(email)}`),
    "END:VCARD",
  ].join("\r\n");
}

let richOps: Promise<RichPhotonOps> | null = null;

function loadRichPhotonOps(): Promise<RichPhotonOps> {
  richOps ??= (async () => {
    const [core, provider] = await Promise.all([
      import("spectrum-ts"),
      import("@spectrum-ts/imessage"),
    ]);
    const {
      Spectrum,
      app,
      attachment,
      contact,
      edit,
      group,
      markdown,
      poll,
      reply,
      richlink,
      text,
      unsend,
      voice,
    } = core;
    const { imessage, nativeContactCard } = provider;
    const spectrum = await Spectrum({
      projectId: env("SPECTRUM_PROJECT_ID") ?? "",
      projectSecret: env("SPECTRUM_PROJECT_SECRET") ?? "",
      providers: [imessage.config()],
    });
    const im = imessage(spectrum);

    const spaceFor = async (
      target: PhotonTarget,
      phone: string | null,
    ) => {
      if (target.kind === "space") {
        return phone === null
          ? im.space.get(target.spaceId)
          : im.space.get(target.spaceId, { phone });
      }
      const user = await im.user(target.handle);
      return phone === null
        ? im.space.create(user)
        : im.space.create(user, { phone });
    };

    const messageStandIn = (
      space: Awaited<ReturnType<typeof spaceFor>>,
      providerMessageId: string,
      direction: "inbound" | "outbound",
      providerState?: Record<string, unknown>,
    ) =>
      ({
        id: providerMessageId,
        direction,
        content: { type: "text", text: "" },
        space,
        ...(providerState ?? {}),
      }) as never;

    const firstId = (
      value:
        | { readonly id?: string }
        | readonly { readonly id?: string }[]
        | undefined,
    ): string | undefined =>
      Array.isArray(value)
        ? value.find((item) => typeof item.id === "string")?.id
        : (value as { readonly id?: string } | undefined)?.id;
    const firstMessage = <T>(value: T | readonly T[]): T | undefined =>
      Array.isArray(value) ? value[0] : (value as T);

    return {
      execute: async (command, ownerHandle) => {
        const payload = record(command.payload);
        const target: PhotonTarget =
          command.target.kind === "dm"
            ? { kind: "dm", handle: ownerHandle }
            : { kind: "space", spaceId: command.target.spaceId };
        if (command.operation === "create_group") {
          const addresses = stringArray(payload, "addresses");
          const users = await Promise.all(addresses.map((address) => im.user(address)));
          const created =
            line(command.phone) === null
              ? await im.space.create(users)
              : await im.space.create(users, { phone: line(command.phone) ?? undefined });
          return { result: { spaceId: created.id } };
        }
        const space = await spaceFor(target, line(command.phone));

        switch (command.operation) {
          case "send_markdown": {
            const sent = await space.send(markdown(stringField(payload, "text")));
            return { providerMessageId: firstId(sent) };
          }
          case "send_album": {
            const urls = stringArray(payload, "urls");
            if (urls.length < 2) throw new Error("an album needs at least two URLs");
            const files = await Promise.all(
              urls.map(async (url) => {
                const file = await fetchPublicMedia(url);
                return attachment(Buffer.from(file.data), {
                  name: new URL(url).pathname.split("/").at(-1) || "attachment",
                  mimeType: file.contentType ?? "application/octet-stream",
                });
              }),
            );
            const sent = await space.send(
              group(
                files[0]!,
                files[1]!,
                ...files.slice(2),
              ),
            );
            return { providerMessageId: firstId(sent) };
          }
          case "send_attachment": {
            const url = stringField(payload, "url");
            const file = await fetchPublicMedia(url);
            const sent = await space.send(
              attachment(Buffer.from(file.data), {
                name:
                  stringField(payload, "name") ||
                  new URL(url).pathname.split("/").at(-1) ||
                  "attachment",
                mimeType:
                  stringField(payload, "contentType") ||
                  file.contentType ||
                  "application/octet-stream",
              }),
            );
            return { providerMessageId: firstId(sent) };
          }
          case "send_voice": {
            const voiceText = stringField(payload, "text");
            const generated =
              voiceText.trim().length > 0
                ? await Effect.runPromise(synthesizeIMessageSpeech(voiceText))
                : null;
            const url = stringField(payload, "url");
            const downloaded =
              generated === null ? await fetchPublicMedia(url) : null;
            const duration = numberField(payload, "duration");
            const sent = await space.send(
              voice(
                generated === null
                  ? Buffer.from(downloaded?.data ?? [])
                  : Buffer.from(generated.bytes),
                {
                ...(duration !== undefined ? { duration } : {}),
                ...(generated !== null
                  ? {
                      name: generated.fileName,
                      mimeType: generated.mediaType,
                    }
                  : {
                      name:
                        stringField(payload, "name") ||
                        new URL(url).pathname.split("/").at(-1) ||
                        "voice.m4a",
                    }),
                ...(generated === null
                  ? {
                      mimeType:
                        stringField(payload, "mimeType") ||
                        downloaded?.contentType ||
                        "audio/mp4",
                    }
                  : {}),
                },
              ),
            );
            return { providerMessageId: firstId(sent) };
          }
          case "send_contact": {
            const vcard =
              stringField(payload, "vcard") || structuredVCard(payload) || "";
            const sent =
              vcard.length > 0
                ? await space.send(contact(vcard))
                : await space.send(nativeContactCard());
            return { providerMessageId: firstId(sent) };
          }
          case "share_contact": {
            await space.send(nativeContactCard());
            return {};
          }
          case "send_richlink": {
            const sent = await space.send(richlink(stringField(payload, "url")));
            return { providerMessageId: firstId(sent) };
          }
          case "send_poll": {
            const choices = stringArray(payload, "choices");
            const sent = await space.send(
              poll(stringField(payload, "title"), [...choices]),
            );
            return { providerMessageId: firstId(sent) };
          }
          case "send_app": {
            const sent = await space.send(
              app(stringField(payload, "url"), { live: boolField(payload, "live") }),
            );
            const message = firstMessage(sent);
            const session =
              message !== undefined &&
              typeof message === "object" &&
              message !== null &&
              "miniAppCardSession" in message
                ? (message as { miniAppCardSession?: unknown }).miniAppCardSession
                : undefined;
            return {
              providerMessageId: firstId(sent),
              ...(session === undefined
                ? {}
                : { result: { miniAppCardSession: session } }),
            };
          }
          case "update_app": {
            const providerMessageId = stringField(payload, "providerMessageId");
            const providerState = record(payload.providerState);
            const session = record(providerState.miniAppCardSession);
            if (Object.keys(session).length === 0) {
              throw new Error("the Mini App card session is unavailable");
            }
            const targetMessage = messageStandIn(
              space,
              providerMessageId,
              "outbound",
              { miniAppCardSession: session },
            );
            await space.send(
              edit(
                app(stringField(payload, "url"), {
                  live: boolField(payload, "live"),
                }),
                targetMessage,
              ),
            );
            return { providerMessageId };
          }
          case "reply": {
            const targetMessage = messageStandIn(
              space,
              stringField(payload, "providerMessageId"),
              "inbound",
            );
            const sent = await space.send(
              reply(markdown(stringField(payload, "text")), targetMessage),
            );
            return { providerMessageId: firstId(sent) };
          }
          case "edit": {
            const providerMessageId = stringField(payload, "providerMessageId");
            await space.send(
              edit(
                text(stringField(payload, "text")),
                messageStandIn(space, providerMessageId, "outbound"),
              ),
            );
            return { providerMessageId };
          }
          case "unsend": {
            await space.send(
              unsend(
                messageStandIn(
                  space,
                  stringField(payload, "providerMessageId"),
                  "outbound",
                ),
              ),
            );
            return {};
          }
          case "rename_group":
            await space.rename(stringField(payload, "name"));
            return {};
          case "add_participant": {
            const users = await Promise.all(
              stringArray(payload, "addresses").map((address) => im.user(address)),
            );
            await space.add(users);
            return {};
          }
          case "remove_participant": {
            const users = await Promise.all(
              stringArray(payload, "addresses").map((address) => im.user(address)),
            );
            await space.remove(users);
            return {};
          }
          case "leave_group":
            await space.leave();
            return {};
          case "set_group_icon": {
            const image = await fetchPublicMedia(stringField(payload, "url"));
            await space.avatar(Buffer.from(image.data), {
              mimeType: image.contentType ?? "image/png",
            });
            return {};
          }
          case "remove_group_icon":
            await space.avatar("clear");
            return {};
          default:
            return null;
        }
      },
    } satisfies RichPhotonOps;
  })();
  richOps.catch(() => {
    richOps = null;
  });
  return richOps;
}

export function executeRichPhotonCommand(
  command: IMessageCommand,
  ownerHandle: string,
): Effect.Effect<PhotonSendResult | null, IMessageError> {
  return Effect.tryPromise({
    try: async () =>
      (await executeStubPhotonCommand(command)) ??
      (await loadRichPhotonOps()).execute(command, ownerHandle),
    catch: (cause) =>
      new IMessageError({
        reason: "spectrum",
        detail: cause instanceof Error ? cause.message : String(cause),
      }),
  });
}
