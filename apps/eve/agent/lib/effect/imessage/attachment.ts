import { Effect } from "effect";

import {
  IMessageError,
  fetchIMessageAttachmentOpaqueSigned,
  fetchIMessageAttachmentSigned,
  type InboundAttachmentBytes,
  type IMessageStoreError,
} from "../imessage";
import type { AttachmentAccess } from "../../imessage-signature";
import type { OpaqueAttachmentAccess } from "../../imessage-signature";
import { downloadAdvancedIMessageAttachment } from "./advanced";
import {
  IMessageRichStore,
  type RichStoreError,
} from "./store";

/**
 * A signed opaque ref is verified by the common router first. Only a
 * provider-level not-found after that successful authorization may fall back
 * to the Advanced Kit attachment stream.
 */
export function fetchBoundIMessageAttachment(input: {
  readonly access: AttachmentAccess;
  readonly signature: string;
}): Effect.Effect<
  InboundAttachmentBytes,
  IMessageStoreError | RichStoreError,
  Parameters<typeof fetchIMessageAttachmentSigned>[0] extends never
    ? never
    : import("../imessage").IMessageRouter | IMessageRichStore
> {
  return fetchIMessageAttachmentSigned(input).pipe(
    Effect.catch((error) => {
      if (
        !(error instanceof IMessageError) ||
        error.reason !== "spectrum" ||
        error.status !== 404
      ) {
        return Effect.fail(error);
      }
      return Effect.gen(function* () {
        const providerAttachmentId = yield* (yield* IMessageRichStore).resolveMessageRef({
          messageRef: input.access.id,
          phone: input.access.phone,
          conversationKey: input.access.conversation,
        });
        return yield* downloadAdvancedIMessageAttachment(providerAttachmentId);
      });
    }),
  );
}

export function fetchOpaqueBoundIMessageAttachment(input: {
  readonly access: OpaqueAttachmentAccess;
  readonly signature: string;
}): Effect.Effect<
  InboundAttachmentBytes,
  IMessageStoreError | RichStoreError,
  import("../imessage").IMessageRouter | IMessageRichStore
> {
  return fetchIMessageAttachmentOpaqueSigned(input).pipe(
    Effect.catch((error) => {
      if (
        !(error instanceof IMessageError) ||
        error.reason !== "spectrum" ||
        error.status !== 404
      ) {
        return Effect.fail(error);
      }
      return Effect.gen(function* () {
        const binding = yield* (yield* IMessageRichStore).inspectMessageRef(
          input.access.ref,
        );
        return yield* downloadAdvancedIMessageAttachment(
          binding.providerMessageId,
        );
      });
    }),
  );
}
