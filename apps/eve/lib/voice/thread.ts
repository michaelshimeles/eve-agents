// Persistence for voice sessions: each session owns one web thread. The orb is
// that thread's ONLY writer, and the SavedChat deliberately has NO `session`
// cursor — the log mixes synthetic transcript events with copied dispatch
// events, so a cursor would desync chat.tsx's reattach logic. forkContext
// carries the transcript so continuing in text hands Ruth the context (the
// existing fork mechanism sends it as one-turn client context).
import type { HandleMessageStreamEvent } from "eve/client";

import { AGENT_NAME } from "../identity";
import {
  compactChatForStorage,
  loadSavedChat,
  loadTombstones,
  queueThreadUpsert,
  saveLocalChat,
  type SavedChat,
  type ThreadMeta,
} from "../thread-sync";
import {
  filterDispatchEvents,
  formatTranscript,
  shouldReuseThread,
  syntheticAssistantEvents,
  syntheticUserEvents,
  transcriptFromEvents,
  voiceThreadTitle,
  type TranscriptEntry,
  type VoiceResumeRecord,
} from "./bridge";

const RESUME_KEY = "eve-voice-last";
const PERSIST_DEBOUNCE_MS = 1_000;
/** Matches the fork-context budget the chat UI uses for a forked transcript. */
const FORK_CONTEXT_LIMIT = 20_000;

export function loadVoiceResume(): VoiceResumeRecord | null {
  try {
    const raw = window.localStorage.getItem(RESUME_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as VoiceResumeRecord;
    if (typeof parsed.threadId !== "string" || typeof parsed.endedAt !== "number") return null;
    // A record missing its title would otherwise persist `title: undefined`,
    // which the thread PUT rejects as an invalid body.
    return {
      ...parsed,
      title: typeof parsed.title === "string" && parsed.title.length > 0 ? parsed.title : voiceThreadTitle(),
      ...(typeof parsed.continuationToken === "string"
        ? { continuationToken: parsed.continuationToken }
        : { continuationToken: undefined }),
    };
  } catch {
    return null;
  }
}

export function saveVoiceResume(record: VoiceResumeRecord): void {
  try {
    window.localStorage.setItem(RESUME_KEY, JSON.stringify(record));
  } catch {
    // quota or private mode — resume is best-effort
  }
}

export function clearVoiceResume(): void {
  try {
    window.localStorage.removeItem(RESUME_KEY);
  } catch {
    // ignore
  }
}

async function fetchServerVoiceChat(threadId: string): Promise<SavedChat | null> {
  try {
    const response = await fetch(`/api/threads/${threadId}`);
    if (!response.ok) return null;
    const body = (await response.json()) as { chat?: SavedChat };
    return body.chat ?? null;
  } catch {
    return null;
  }
}

export class VoiceThreadWriter {
  private events: HandleMessageStreamEvent[];
  private entries: TranscriptEntry[];
  private meta: ThreadMeta;
  private sequence: number;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private announced = false;
  /** Set when another writer has taken the thread over; stops all writes. */
  private retired = false;
  readonly resumeToken: string | undefined;

  private constructor(
    meta: ThreadMeta,
    events: HandleMessageStreamEvent[],
    entries: TranscriptEntry[],
    resumeToken: string | undefined,
  ) {
    this.meta = meta;
    this.events = events;
    this.entries = entries;
    this.sequence = events.length + 1;
    this.resumeToken = resumeToken;
  }

  /**
   * Open a writer: reuse the last voice thread when it ended under 30 minutes
   * ago, wasn't deleted, and hasn't been taken over by a text session
   * (server copy grew a `session` cursor); otherwise mint a fresh thread.
   */
  static async open(): Promise<VoiceThreadWriter> {
    const resume = loadVoiceResume();
    if (shouldReuseThread(resume, Date.now()) && resume !== null) {
      const tombstones = loadTombstones();
      if (tombstones[resume.threadId] === undefined) {
        const server = await fetchServerVoiceChat(resume.threadId);
        const local = loadSavedChat(resume.threadId);
        const takenOver = server?.session !== undefined || local?.session !== undefined;
        if (!takenOver) {
          const serverEvents = server?.events ?? [];
          const localEvents = local?.events ?? [];
          const events = [...(serverEvents.length >= localEvents.length ? serverEvents : localEvents)];
          const meta: ThreadMeta = {
            id: resume.threadId,
            title: resume.title,
            updatedAt: Date.now(),
            renamed: true,
            origin: "voice",
          };
          return new VoiceThreadWriter(meta, events, transcriptFromEvents(events), resume.continuationToken);
        }
      }
    }
    const meta: ThreadMeta = {
      id: crypto.randomUUID(),
      title: voiceThreadTitle(),
      updatedAt: Date.now(),
      renamed: true,
      origin: "voice",
    };
    return new VoiceThreadWriter(meta, [], [], undefined);
  }

  get threadId(): string {
    return this.meta.id;
  }

  get transcript(): readonly TranscriptEntry[] {
    return this.entries;
  }

  appendUser(text: string): void {
    this.entries.push({ role: "user", text, at: Date.now() });
    this.events.push(...syntheticUserEvents(text, `voice:${crypto.randomUUID()}`, this.sequence));
    this.sequence += 1;
    this.schedulePersist();
  }

  appendAssistant(text: string): void {
    this.entries.push({ role: "assistant", text, at: Date.now() });
    this.events.push(...syntheticAssistantEvents(text, `voice:${crypto.randomUUID()}`, this.sequence));
    this.sequence += 2;
    this.schedulePersist();
  }

  /** Copy a settled dispatch turn's real events into the thread log. */
  appendDispatch(events: readonly HandleMessageStreamEvent[]): void {
    const kept = filterDispatchEvents(events);
    this.events.push(...kept);
    this.sequence += kept.length;
    this.persist();
  }

  /** Flush and record the resume window (called when the orb closes). */
  finish(continuationToken?: string): void {
    this.persist();
    saveVoiceResume({
      threadId: this.meta.id,
      title: this.meta.title,
      endedAt: Date.now(),
      ...(continuationToken !== undefined ? { continuationToken } : {}),
    });
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persist(), PERSIST_DEBOUNCE_MS);
  }

  /** Stop writing (a newer writer or a text session owns this thread now). */
  retire(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.retired = true;
  }

  private persist(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.retired || this.events.length === 0) return;
    // Never write a shorter log than what is already stored, and never write at
    // all once a text session has adopted the thread — both would silently
    // erase the other writer's turns (the row is replaced wholesale).
    const stored = loadSavedChat(this.meta.id);
    if (stored !== null) {
      if (stored.session !== undefined) {
        this.retired = true;
        return;
      }
      if ((stored.events?.length ?? 0) > this.events.length) {
        this.retired = true;
        return;
      }
    }
    const savedAt = Math.max(Date.now(), this.meta.updatedAt + 1);
    this.meta = { ...this.meta, updatedAt: savedAt };
    // Compact like chat.tsx's persistChat does: dispatch turns can carry big
    // data: URLs (attachments Ruth produced) that would blow the row budget.
    const chat: SavedChat = compactChatForStorage({
      events: [...this.events],
      savedAt,
      forkContext: formatTranscript(this.entries, AGENT_NAME).slice(-FORK_CONTEXT_LIMIT),
    });
    saveLocalChat(this.meta.id, chat);
    queueThreadUpsert(this.meta, chat);
    if (!this.announced) {
      this.announced = true;
      // Let an open chat tab refresh its sidebar promptly; the PUT above is
      // queued, so give it a moment to land before the tab refetches.
      setTimeout(() => window.dispatchEvent(new Event("eve:threads-changed")), 1_500);
    }
  }
}
