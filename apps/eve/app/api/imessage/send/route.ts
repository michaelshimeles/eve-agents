import {
  sendIMessageAsDeployment,
  sendIMessageAttachmentAsDeployment,
  sendIMessageEffectAsDeployment,
  sendIMessageReactionAsDeployment,
  sendIMessageRichlinkAsDeployment,
  setIMessageBackgroundAsDeployment,
} from "@/agent/lib/effect/imessage";
import { bearerToken, respondWith, stringField } from "@/lib/imessage-api";

// Router API: outbound sends for paired deployments. The bearer secret must
// match the handle's registry row, which is the whole authorization model —
// a deployment can only ever reach its own paired owner, never anyone else
// on the shared line. The body picks the content kind:
//
//   { text }                                  plain text
//   { text, effect }                          text with a bubble/screen effect
//   { attachment: { url, name?, contentType? } }  native file attachment
//   { reaction: { emoji, targetMessageId } }  tapback on an inbound message
//   { richlink }                              URL as a native rich-link card
//   { background }                            chat background URL, or "clear"

export const maxDuration = 60;

/** The attachment object out of an untyped JSON body, or null. */
function attachmentField(body: unknown): { url: string; name?: string; contentType?: string } | null {
  if (body === null || typeof body !== "object") return null;
  const raw = (body as Record<string, unknown>).attachment;
  if (raw === null || raw === undefined || typeof raw !== "object") return null;
  const url = stringField(raw, "url");
  if (url.length === 0) return null;
  const name = stringField(raw, "name");
  const contentType = stringField(raw, "contentType");
  return {
    url,
    ...(name.length > 0 ? { name } : {}),
    ...(contentType.length > 0 ? { contentType } : {}),
  };
}

/** The reaction object out of an untyped JSON body, or null. */
function reactionField(body: unknown): { emoji: string; targetMessageId: string } | null {
  if (body === null || typeof body !== "object") return null;
  const raw = (body as Record<string, unknown>).reaction;
  if (raw === null || raw === undefined || typeof raw !== "object") return null;
  const emoji = stringField(raw, "emoji");
  const targetMessageId = stringField(raw, "targetMessageId");
  if (emoji.length === 0 || targetMessageId.length === 0) return null;
  return { emoji, targetMessageId };
}

export async function POST(request: Request): Promise<Response> {
  const secret = bearerToken(request);
  if (secret === null) return new Response("Unauthorized", { status: 401 });
  const body: unknown = await request.json().catch(() => null);
  const handle = stringField(body, "handle");
  const phone = stringField(body, "phone");
  const pinned = phone.length > 0 ? { phone } : {};

  const attachment = attachmentField(body);
  if (attachment !== null) {
    return respondWith(
      sendIMessageAttachmentAsDeployment({ handle, secret, file: attachment, ...pinned }),
    );
  }

  const reaction = reactionField(body);
  if (reaction !== null) {
    return respondWith(sendIMessageReactionAsDeployment({ handle, secret, reaction, ...pinned }));
  }

  const richlink = stringField(body, "richlink");
  if (richlink.length > 0) {
    return respondWith(sendIMessageRichlinkAsDeployment({ handle, secret, url: richlink, ...pinned }));
  }

  const background = stringField(body, "background");
  if (background.length > 0) {
    return respondWith(setIMessageBackgroundAsDeployment({ handle, secret, background, ...pinned }));
  }

  const effect = stringField(body, "effect");
  if (effect.length > 0) {
    return respondWith(
      sendIMessageEffectAsDeployment({ handle, secret, text: stringField(body, "text"), effect, ...pinned }),
    );
  }

  return respondWith(
    sendIMessageAsDeployment({ handle, secret, text: stringField(body, "text"), ...pinned }),
  );
}
