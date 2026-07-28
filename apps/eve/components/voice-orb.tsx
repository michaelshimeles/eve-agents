"use client";

// The voice orb: a Siri-style floating button (bottom-right, all pages) that
// runs a live GPT Realtime conversation as Ruth's voice and bridges real work
// into the eve agent. Renders nothing unless the server reports the voice
// feature enabled (OPENAI_API_KEY present).
import {
  CameraIcon,
  FileIcon,
  MicrophoneIcon,
  PaperclipIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { AGENT_NAME } from "@/lib/identity";
import { cn } from "@/lib/utils";
import {
  describeAttachments,
  downscaleToFit,
  formatBytes,
  glanceBudget,
  isGlanceable,
  rejectionNote,
  stageAttachments,
  type VoiceAttachment,
} from "@/lib/voice/attachments";
import {
  NarrationGate,
  SILENCE_TIMEOUT_MS,
  buildDispatchContext,
  describeInputRequests,
  formatTranscript,
  matchInputResponses,
  toolPhrase,
  transcriptWindow,
} from "@/lib/voice/bridge";
import type { InputRequest } from "eve/client";
import type { DispatchResult } from "@/lib/voice/dispatch";
import { RuthDispatcher } from "@/lib/voice/dispatch";
import { RealtimeVoiceSession } from "@/lib/voice/realtime";
import { VoiceThreadWriter } from "@/lib/voice/thread";

type OrbState = "idle" | "connecting" | "listening" | "speaking" | "working" | "error";

/**
 * Images stay in the Realtime conversation once shown and are re-billed as
 * image tokens on every later turn, so a session cannot keep glancing forever.
 * Past this, files are still delivered to the agent — just announced by name.
 */
const MAX_GLANCES_PER_SESSION = 8;

const STATE_LABEL: Record<OrbState, string> = {
  idle: "",
  connecting: "Connecting…",
  listening: "Listening",
  speaking: "",
  working: `${AGENT_NAME} is working…`,
  error: "Something went wrong — tap to retry",
};

export function VoiceOrb() {
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<OrbState>("idle");
  const [caption, setCaption] = useState("");
  const [attachments, setAttachments] = useState<VoiceAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  // Set when Ruth asks for a file. Browsers only open a file picker from a real
  // user gesture, so her request has to become a button the user taps.
  const [filePrompt, setFilePrompt] = useState<"photo" | "file" | null>(null);

  // Authoritative staged list, updated synchronously alongside setAttachments.
  // Assigning it during render would lag writes made from async ingest work.
  const attachmentsRef = useRef<VoiceAttachment[]>([]);
  const attachQueueRef = useRef<Promise<void>>(Promise.resolve());
  const glanceCountRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const realtimeRef = useRef<RealtimeVoiceSession | null>(null);
  const writerRef = useRef<VoiceThreadWriter | null>(null);
  const dispatcherRef = useRef<RuthDispatcher | null>(null);
  const gateRef = useRef(new NarrationGate());
  const pendingRequestsRef = useRef<readonly InputRequest[] | null>(null);
  const dispatchedFromRef = useRef(0);
  const userSpeakingRef = useRef(false);
  const lastActivityRef = useRef(0);
  const stateRef = useRef<OrbState>("idle");
  stateRef.current = state;
  // Bumped on every start/stop. Async work captures the generation it began in
  // and does nothing if the orb has been closed or restarted since — otherwise
  // a dispatch settling late would speak into a session that no longer exists.
  const generationRef = useRef(0);

  useEffect(() => {
    function check(): void {
      void fetch("/api/features")
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { voice?: boolean } | null) => setEnabled(body?.voice === true))
        .catch(() => setEnabled(false));
    }
    check();
    window.addEventListener("eve:features-changed", check);
    return () => window.removeEventListener("eve:features-changed", check);
  }, []);

  const stop = useCallback(() => {
    generationRef.current += 1;
    realtimeRef.current?.close();
    realtimeRef.current = null;
    writerRef.current?.finish(dispatcherRef.current?.continuationToken);
    // Keep the writer + dispatcher alive: an in-flight dispatch still appends
    // its result to the thread after the orb closes (while the tab is open).
    setCaption("");
    // Session-scoped state — staging, glance count, drag latch, file prompt —
    // is reset by the effect watching `active`, which the error path hits too.
    setState("idle");
  }, []);

  const settleFunctionCall = useCallback(
    (generation: number, callId: string, output: Record<string, unknown>) => {
      if (generation !== generationRef.current) return;
      realtimeRef.current?.sendFunctionOutput(callId, JSON.stringify(output));
      realtimeRef.current?.createResponse();
    },
    [],
  );

  /**
   * One destination for every way a file arrives. Images get a downscaled
   * glance the voice model can actually see; everything else is announced by
   * name. Either way the original is staged for the next dispatch.
   *
   * Ingests are serialized: two overlapping drops would each read the staged
   * count before either finished, and both would be allowed past the cap.
   */
  const attachFiles = useCallback((files: Iterable<File>): Promise<void> => {
    // Materialize now. A FileList from an <input> is emptied the moment we
    // reset input.value, which would strand every file after the first.
    const list = [...files];
    // Captured at selection time, not when the queued job finally runs: a job
    // delayed behind another ingest could otherwise start after a restart,
    // read the NEW generation, pass every fence, and stage files the user
    // picked for a session they have since dismissed.
    const generation = generationRef.current;
    const run = async (): Promise<void> => {
      if (generation !== generationRef.current) return;
      const realtime = realtimeRef.current;
      if (realtime === null || list.length === 0) return;
      const { accepted, rejected } = await stageAttachments(list, attachmentsRef.current.length);
      // The session can end while files are being read; staging into a dead
      // session would leave attachments that never reach anyone.
      if (generation !== generationRef.current || realtimeRef.current !== realtime) return;
      if (accepted.length > 0) {
        attachmentsRef.current = [...attachmentsRef.current, ...accepted];
        setAttachments(attachmentsRef.current);
        // A file arrived, so the request that put the button there is answered
        // — even if it arrived by drag or paste instead of through the button.
        setFilePrompt(null);
      }
      const budget = glanceBudget(realtime.maxMessageBytes);
      const unseen: VoiceAttachment[] = [];
      for (const attachment of accepted) {
        // Every glance stays in the conversation and is re-billed as image
        // tokens on later turns, so the count per session is bounded.
        const allowed = glanceCountRef.current < MAX_GLANCES_PER_SESSION;
        const glance =
          allowed && isGlanceable(attachment.mediaType)
            ? await downscaleToFit(attachment.dataUrl, budget)
            : null;
        if (generation !== generationRef.current) return;
        if (glance === null) unseen.push(attachment);
        else {
          glanceCountRef.current += 1;
          realtime.addImageItem(glance);
        }
      }
      const notes: string[] = [];
      if (unseen.length > 0) {
        notes.push(
          `The user attached ${describeAttachments(unseen)}. You cannot see ${unseen.length === 1 ? "it" : "them"}, but the backend can read the original.`,
        );
      }
      const rejection = rejectionNote(rejected);
      if (rejection !== null) notes.push(`These were not attached: ${rejection}.`);
      if (notes.length > 0) realtime.addContextItem(notes.join(" "));
      if (accepted.length > 0 || notes.length > 0) {
        realtime.createResponse(
          "In one short line, say what the user just shared with you. Do not analyze it and do not invent detail. Then wait for them.",
        );
      }
    };
    attachQueueRef.current = attachQueueRef.current.then(run, run);
    return attachQueueRef.current;
  }, []);

  /**
   * Shared tail of both bridge tools: record the turn in the thread, restore
   * the orb state, and hand the outcome back to the voice model. When the orb
   * was closed mid-flight the result still lands in the thread (and refreshes
   * the resume token) — it just never gets spoken.
   */
  const settleDispatch = useCallback(
    (generation: number, callId: string, writer: VoiceThreadWriter, result: DispatchResult) => {
      writer.appendDispatch(result.events);
      lastActivityRef.current = Date.now();
      const current = generation === generationRef.current;
      if (!current) {
        writer.finish(dispatcherRef.current?.continuationToken);
        return;
      }
      if (stateRef.current === "working") setState("listening");
      if (result.busy === true) {
        settleFunctionCall(generation, callId, {
          status: "busy",
          note: "Still working on the previous request.",
        });
      } else if (result.parked !== null) {
        pendingRequestsRef.current = result.parked;
        settleFunctionCall(generation, callId, {
          status: "needs_input",
          question: describeInputRequests(result.parked),
        });
      } else if (result.authorization !== null) {
        settleFunctionCall(generation, callId, {
          status: "needs_authorization",
          connection: result.authorization,
          note: "The sign-in link is in the chat thread; it cannot be completed by voice.",
        });
      } else if (result.failure !== null) {
        settleFunctionCall(generation, callId, { status: "failed", error: result.failure });
      } else {
        settleFunctionCall(generation, callId, {
          status: "done",
          result: result.reply ?? "Done — no summary was produced.",
        });
      }
    },
    [settleFunctionCall],
  );

  const handleAskRuth = useCallback(
    async (generation: number, callId: string, request: string) => {
      const writer = writerRef.current;
      const dispatcher = dispatcherRef.current;
      if (writer === null || dispatcher === null) return;
      if (dispatcher.busy) {
        settleFunctionCall(generation, callId, {
          status: "busy",
          note: "Still working on the previous request; results will follow shortly.",
        });
        return;
      }
      setState("working");
      gateRef.current.reset();
      const window_ = transcriptWindow(writer.transcript, dispatchedFromRef.current);
      dispatchedFromRef.current = writer.transcript.length;
      // Staging clears as the turn leaves: the files ride along on this
      // dispatch only, and the thread records what was handed over.
      const staged = attachmentsRef.current;
      if (staged.length > 0) {
        // The ref is the authoritative list, so it has to be emptied here too:
        // clearing only the state would leave these files attached to every
        // later dispatch and count against the five-file cap forever.
        attachmentsRef.current = [];
        setAttachments([]);
        writer.appendUser(`[shared ${describeAttachments(staged)}]`);
      }
      const result = await dispatcher.dispatch(
        request,
        buildDispatchContext(window_, AGENT_NAME),
        staged,
        (tool) => {
          lastActivityRef.current = Date.now();
          if (generation !== generationRef.current) return;
          if (gateRef.current.shouldNarrate(tool, Date.now(), userSpeakingRef.current)) {
            realtimeRef.current?.createResponse(
              `In a few words, tell the user you're now ${toolPhrase(tool)}. Do not invent any results.`,
            );
          } else {
            // Suppressed narration still becomes context, so the model can
            // mention what happened without being prompted to speak now.
            realtimeRef.current?.addContextItem(`Progress: ${toolPhrase(tool)}.`);
          }
        },
      );
      settleDispatch(generation, callId, writer, result);
    },
    [settleDispatch, settleFunctionCall],
  );

  const handleAnswerRuth = useCallback(
    async (generation: number, callId: string, answer: string) => {
      const writer = writerRef.current;
      const dispatcher = dispatcherRef.current;
      const pending = pendingRequestsRef.current;
      if (writer === null || dispatcher === null) return;
      if (pending === null || pending.length === 0) {
        settleFunctionCall(generation, callId, {
          status: "error",
          note: "Nothing is waiting for an answer.",
        });
        return;
      }
      if (dispatcher.busy) {
        // Keep the pending request: the answer can be relayed once the current
        // turn settles, instead of being silently dropped.
        settleFunctionCall(generation, callId, {
          status: "busy",
          note: "Still finishing the previous request — ask again in a moment.",
        });
        return;
      }
      pendingRequestsRef.current = null;
      setState("working");
      const result = await dispatcher.answer(matchInputResponses(pending, answer));
      settleDispatch(generation, callId, writer, result);
    },
    [settleDispatch, settleFunctionCall],
  );

  const start = useCallback(async () => {
    // Never stack sessions: close whatever came before and claim a generation.
    realtimeRef.current?.close();
    realtimeRef.current = null;
    generationRef.current += 1;
    const generation = generationRef.current;
    // Tracked separately from realtimeRef so a late failure only ever tears
    // down the session this attempt created — by then a retry may have put a
    // live session in the ref, and closing that one would kill a working call.
    let created: RealtimeVoiceSession | null = null;
    setState("connecting");
    setCaption("");
    try {
      const tokenResponse = await fetch("/api/voice/token", { method: "POST" });
      if (!tokenResponse.ok) {
        const body = (await tokenResponse.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Token mint failed (${tokenResponse.status})`);
      }
      if (generation !== generationRef.current) return;
      const { value } = (await tokenResponse.json()) as { value: string };
      // Reuse the live writer/dispatcher when a previous session is still
      // finishing work on the same thread — two writers on one thread id
      // overwrite each other's event logs.
      const previous = writerRef.current;
      const reusable = previous !== null && dispatcherRef.current?.busy === true;
      const writer = reusable && previous !== null ? previous : await VoiceThreadWriter.open();
      if (generation !== generationRef.current) return;
      if (!reusable && previous !== null && previous !== writer) previous.retire();
      writerRef.current = writer;
      // On reuse, replay the recent spoken history to the next dispatch so
      // references like "that restaurant" still resolve.
      dispatchedFromRef.current = reusable ? dispatchedFromRef.current : 0;
      if (!reusable) dispatcherRef.current = new RuthDispatcher(writer.resumeToken);
      pendingRequestsRef.current = null;
      lastActivityRef.current = Date.now();

      // A closed session can still deliver queued events, and when voice is
      // restarted during an in-flight dispatch the writer is deliberately
      // reused — so an unfenced callback would write dismissed speech into the
      // live thread, or nudge the live session's timers and speaking state.
      // Every callback below is fenced on the generation that created it.
      const isCurrent = (): boolean => generation === generationRef.current;

      const realtime = new RealtimeVoiceSession({
        onUserTranscript: (text, final) => {
          if (!isCurrent()) return;
          setCaption(text);
          lastActivityRef.current = Date.now();
          if (final) {
            userSpeakingRef.current = false;
            writer.appendUser(text);
          }
        },
        onAssistantTranscript: (text, final) => {
          if (!isCurrent()) return;
          setCaption(text);
          if (final) writer.appendAssistant(text);
        },
        onAssistantSpeaking: (speaking) => {
          if (!isCurrent()) return;
          lastActivityRef.current = Date.now();
          setState((previous) =>
            previous === "working" || previous === "idle" || previous === "error"
              ? previous
              : speaking
                ? "speaking"
                : "listening",
          );
        },
        onUserSpeechStarted: () => {
          if (!isCurrent()) return;
          userSpeakingRef.current = true;
          lastActivityRef.current = Date.now();
          setState((previous) => (previous === "speaking" ? "listening" : previous));
        },
        onUserSpeechStopped: () => {
          if (!isCurrent()) return;
          // Cleared here rather than on the transcript: an utterance that
          // transcribes to nothing would otherwise latch this on forever and
          // mute progress narration for the rest of the session.
          userSpeakingRef.current = false;
          lastActivityRef.current = Date.now();
        },
        onFunctionCall: ({ callId, name, args }) => {
          if (!isCurrent()) return;
          lastActivityRef.current = Date.now();
          if (name === "ask_ruth") {
            const request = typeof args.request === "string" ? args.request : "";
            if (request.length === 0) {
              settleFunctionCall(generation, callId, { status: "error", note: "Empty request." });
              return;
            }
            void handleAskRuth(generation, callId, request);
          } else if (name === "answer_ruth") {
            void handleAnswerRuth(generation, callId, typeof args.answer === "string" ? args.answer : "");
          } else if (name === "stop_task") {
            void dispatcherRef.current?.cancel().then((cancelled) => {
              settleFunctionCall(generation, callId, {
                status: cancelled ? "stopped" : "nothing_running",
              });
            });
          } else if (name === "request_file") {
            // Calling .click() here would be ignored: this runs from a data
            // channel message, which carries no user activation. Surface a
            // button instead and let the user open the picker themselves.
            setFilePrompt(args.kind === "photo" ? "photo" : "file");
            settleFunctionCall(generation, callId, {
              status: "prompted",
              note: "A button is now showing next to the orb. Tell the user to tap it — you cannot open the picker yourself.",
            });
          } else {
            settleFunctionCall(generation, callId, { status: "error", note: `Unknown tool ${name}.` });
          }
        },
        onError: (message, fatal) => {
          if (generation !== generationRef.current) return;
          setCaption(message);
          if (!fatal) return;
          // The wrapper already closed the connection; drop our handle too so
          // a retry starts clean instead of stacking on a dead session.
          realtimeRef.current = null;
          writerRef.current?.finish(dispatcherRef.current?.continuationToken);
          setState("error");
        },
        onClosed: () => {
          if (generation !== generationRef.current) return;
          if (stateRef.current !== "idle" && stateRef.current !== "error") setState("idle");
        },
      });
      created = realtime;
      realtimeRef.current = realtime;
      await realtime.connect(value);
      if (generation !== generationRef.current) {
        // Stopped while connecting — tear the fresh session straight back down
        // so the microphone does not stay live.
        realtime.close();
        if (realtimeRef.current === realtime) realtimeRef.current = null;
        return;
      }
      const seed = transcriptWindow(writer.transcript, dispatchedFromRef.current);
      if (seed.length > 0) {
        realtime.addContextItem(
          `Earlier in this conversation:\n${formatTranscript(seed, AGENT_NAME)}`,
        );
      }
      setState("listening");
    } catch (error) {
      created?.close();
      // Only surrender the ref if it is still ours; a newer attempt owns it now.
      if (realtimeRef.current === created) realtimeRef.current = null;
      if (generation !== generationRef.current) return;
      setCaption(error instanceof Error ? error.message : "Could not start voice");
      setState("error");
    }
  }, [handleAnswerRuth, handleAskRuth, settleFunctionCall]);

  const active = state !== "idle" && state !== "error";

  const toggle = useCallback(() => {
    if (active) stop();
    else void start();
  }, [active, start, stop]);

  // Silence timeout: close a session nobody is using (Realtime bills per
  // connected minute). Never fires while a dispatch is running.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      const idleFor = Date.now() - lastActivityRef.current;
      const busy = dispatcherRef.current?.busy === true;
      if (idleFor > SILENCE_TIMEOUT_MS && !busy && stateRef.current === "listening") stop();
    }, 10_000);
    return () => clearInterval(timer);
  }, [active, stop]);

  // Everything that only means something inside a live session dies with it.
  // Hung off `active` rather than stop(), because a fatal error lands in the
  // "error" state without ever passing through stop(): staging left behind
  // there would ride along on the next session's first dispatch, unseen by
  // anyone, and a drag in flight when the session died would leave the drop
  // overlay latched on forever (its leave handler bails while inactive).
  useEffect(() => {
    if (active) return;
    attachmentsRef.current = [];
    setAttachments([]);
    glanceCountRef.current = 0;
    setFilePrompt(null);
    dragDepth.current = 0;
    setDragging(false);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") stop();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, stop]);

  // Paste is a window-level gesture: there is nothing to focus on the orb, so
  // it only listens while a session is live.
  useEffect(() => {
    if (!active) return;
    function onPaste(event: ClipboardEvent): void {
      // Never steal a paste aimed at a real input — the chat composer takes
      // pasted screenshots too, and the orb must not intercept those.
      const target = event.target;
      if (target instanceof HTMLElement) {
        const editable =
          target.isContentEditable ||
          target.closest("input, textarea, [contenteditable='true']") !== null;
        if (editable) return;
      }
      const files = event.clipboardData?.files;
      if (files === undefined || files.length === 0) return;
      event.preventDefault();
      void attachFiles(files);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [active, attachFiles]);

  useEffect(() => () => realtimeRef.current?.close(), []);

  if (!enabled) return null;

  const label = STATE_LABEL[state];

  // z-[60] keeps the orb above the desktop drawer (z-50, fixed inset-y-0 end-0)
  // and the command palette, so it stays reachable while watching Ruth work on
  // her cloud desktop — exactly when talking to her is most useful.
  return (
    <div
      className="fixed right-4 bottom-4 z-[60] flex flex-col items-end gap-2"
      onDragEnter={(event) => {
        if (!active || ![...event.dataTransfer.types].includes("Files")) return;
        event.preventDefault();
        // Counted, not toggled: nested children fire their own enter/leave
        // pairs and a boolean would flicker as the pointer crosses them.
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (active && [...event.dataTransfer.types].includes("Files")) event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (!active || ![...event.dataTransfer.types].includes("Files")) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(event) => {
        if (!active || ![...event.dataTransfer.types].includes("Files")) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        void attachFiles(event.dataTransfer.files);
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files) void attachFiles(event.target.files);
          // Cleared so picking the same file twice still fires a change.
          event.target.value = "";
        }}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(event) => {
          if (event.target.files) void attachFiles(event.target.files);
          event.target.value = "";
        }}
      />
      {active && attachments.length > 0 && (
        <AttachmentGroup className="max-w-72">
          {attachments.map((attachment) => (
            <Attachment key={attachment.id} size="sm">
              <AttachmentMedia
                variant={attachment.mediaType.startsWith("image/") ? "image" : "icon"}
              >
                {attachment.mediaType.startsWith("image/") ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={attachment.dataUrl} alt={attachment.name} />
                ) : (
                  <FileIcon />
                )}
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle>{attachment.name}</AttachmentTitle>
                <AttachmentDescription>{formatBytes(attachment.size)}</AttachmentDescription>
              </AttachmentContent>
              <AttachmentActions>
                <AttachmentAction
                  aria-label={`Remove ${attachment.name}`}
                  icon={XIcon}
                  onClick={() => {
                    attachmentsRef.current = attachmentsRef.current.filter(
                      (item) => item.id !== attachment.id,
                    );
                    setAttachments(attachmentsRef.current);
                    // A glance already shown to the model cannot be recalled,
                    // so say it is withdrawn rather than let her keep citing it.
                    realtimeRef.current?.addContextItem(
                      `The user removed ${attachment.name}; it will not be sent. Ignore it from now on.`,
                    );
                  }}
                />
              </AttachmentActions>
            </Attachment>
          ))}
        </AttachmentGroup>
      )}
      {dragging && (
        <div className="pointer-events-none flex items-center gap-2 rounded-xl border-2 border-dashed border-kumo-interact bg-kumo-base/90 px-4 py-3 text-sm font-medium">
          <PaperclipIcon className="size-4" />
          Drop to show {AGENT_NAME}
        </div>
      )}
      {active && filePrompt !== null && (
        <button
          type="button"
          onClick={() => {
            (filePrompt === "photo" ? cameraInputRef : fileInputRef).current?.click();
            setFilePrompt(null);
          }}
          className="flex items-center gap-2 rounded-xl bg-kumo-brand px-3 py-2 text-sm font-medium text-white shadow-lg"
        >
          {filePrompt === "photo" ? <CameraIcon className="size-4" /> : <PaperclipIcon className="size-4" />}
          {filePrompt === "photo" ? `Take a photo for ${AGENT_NAME}` : `Choose a file for ${AGENT_NAME}`}
        </button>
      )}
      {(caption.length > 0 || label.length > 0) && state !== "idle" && (
        <div className="line-clamp-4 max-w-72 rounded-xl bg-kumo-base px-3 py-2 text-sm text-kumo-default shadow-lg ring ring-kumo-line">
          {caption.length > 0 ? caption : label}
        </div>
      )}
      <div className="flex items-center gap-2">
        {active && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Attach a file"
              title="Attach a file"
              onClick={() => fileInputRef.current?.click()}
              className="flex size-9 items-center justify-center rounded-full bg-kumo-base text-kumo-subtle ring ring-kumo-line hover:text-kumo-default"
            >
              <PaperclipIcon className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Take a photo"
              title="Take a photo"
              onClick={() => cameraInputRef.current?.click()}
              className="flex size-9 items-center justify-center rounded-full bg-kumo-base text-kumo-subtle ring ring-kumo-line hover:text-kumo-default"
            >
              <CameraIcon className="size-4" />
            </button>
          </div>
        )}
        <button
          type="button"
          aria-label={active ? `Stop talking to ${AGENT_NAME}` : `Talk to ${AGENT_NAME}`}
          onClick={toggle}
          className="group relative size-14 rounded-full outline-none"
        >
          <span
            aria-hidden
            className={cn(
              "absolute -inset-1 rounded-full blur-md transition-opacity duration-500",
              "bg-[conic-gradient(from_0deg,#818cf8,#38bdf8,#e879f9,#818cf8)]",
              state === "idle" && "opacity-25 group-hover:opacity-50",
              state === "connecting" && "animate-pulse opacity-60",
              state === "listening" && "animate-[spin_3s_linear_infinite] opacity-80",
              state === "speaking" && "animate-[spin_1.2s_linear_infinite] opacity-100",
              state === "working" && "animate-pulse opacity-70",
              state === "error" && "bg-red-500 bg-none opacity-60",
            )}
          />
          <span
            className={cn(
              "relative flex size-14 items-center justify-center rounded-full bg-kumo-base ring ring-kumo-line",
              state === "speaking" && "scale-105",
              "transition-transform duration-300",
            )}
          >
            {active ? (
              <XIcon className="size-5 text-kumo-subtle" />
            ) : (
              <MicrophoneIcon className="size-5 text-kumo-default" />
            )}
          </span>
        </button>
      </div>
    </div>
  );
}
