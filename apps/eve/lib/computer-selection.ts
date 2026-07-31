export const COMPUTER_THREAD_KEY = "eve-web-computer-thread";
export const ACTIVE_COMPUTER_TURN_KEY = "eve-web-active-computer-turn";
export const LEGACY_COMPUTER_PARAM = "computer";

export interface ActiveComputerTurn {
  threadId: string;
  title: string;
}

export interface ComputerSelectionState {
  selectedThreadId: string | null;
  activeTurn: ActiveComputerTurn | null;
}

export type ComputerSelectionAction =
  | { type: "request"; threadId: string; title: string }
  | { type: "turn-started"; threadId: string; title: string }
  | { type: "turn-finished"; threadId: string }
  | { type: "thread-deleted"; threadId: string };

export interface ComputerSelectionResult {
  ok: boolean;
  selected: boolean;
  conflict?: ActiveComputerTurn;
}

export interface ComputerSelectionTransition {
  state: ComputerSelectionState;
  result: ComputerSelectionResult;
}

/**
 * Pure tab-local selection/lease state machine. Selection can move freely
 * while idle; an active computer-directed turn pins ownership until it
 * settles, even if its thread is deleted in the meantime.
 */
export function transitionComputerSelection(
  state: ComputerSelectionState,
  action: ComputerSelectionAction,
): ComputerSelectionTransition {
  if (action.type === "request") {
    if (state.activeTurn !== null) {
      if (state.activeTurn.threadId === action.threadId) {
        return { state, result: { ok: true, selected: true } };
      }
      return {
        state,
        result: { ok: false, selected: false, conflict: state.activeTurn },
      };
    }
    const selectedThreadId =
      state.selectedThreadId === action.threadId ? null : action.threadId;
    return {
      state: { ...state, selectedThreadId },
      result: { ok: true, selected: selectedThreadId === action.threadId },
    };
  }

  if (action.type === "turn-started") {
    const next = {
      selectedThreadId: action.threadId,
      activeTurn: { threadId: action.threadId, title: action.title },
    };
    return { state: next, result: { ok: true, selected: true } };
  }

  if (action.type === "turn-finished") {
    if (state.activeTurn?.threadId !== action.threadId) {
      return {
        state,
        result: {
          ok: true,
          selected: state.selectedThreadId === action.threadId,
        },
      };
    }
    return {
      state: { ...state, activeTurn: null },
      result: {
        ok: true,
        selected: state.selectedThreadId === action.threadId,
      },
    };
  }

  const selectedThreadId =
    state.selectedThreadId === action.threadId ? null : state.selectedThreadId;
  return {
    // Keep the transient lease: its background callback still owns release.
    state: { selectedThreadId, activeTurn: state.activeTurn },
    result: { ok: true, selected: false },
  };
}

export function loadComputerThread(): string | null {
  try {
    return sessionStorage.getItem(COMPUTER_THREAD_KEY);
  } catch {
    return null;
  }
}

export function saveComputerThread(threadId: string | null): void {
  try {
    if (threadId === null) sessionStorage.removeItem(COMPUTER_THREAD_KEY);
    else sessionStorage.setItem(COMPUTER_THREAD_KEY, threadId);
  } catch {
    // Selection still lives in React state for the rest of this tab.
  }
}

/**
 * The lease is transient and tab-local, but it must survive a reload while
 * the durable Eve turn keeps running. Its owning ChatThread clears it only
 * after recovery verifies the turn's tail, park, failure, or cancellation.
 */
export function loadActiveComputerTurn(): ActiveComputerTurn | null {
  try {
    const serialized = sessionStorage.getItem(ACTIVE_COMPUTER_TURN_KEY);
    if (serialized === null) return null;
    const parsed = JSON.parse(serialized) as Partial<ActiveComputerTurn>;
    return typeof parsed.threadId === "string" &&
      parsed.threadId.length > 0 &&
      typeof parsed.title === "string" &&
      parsed.title.length > 0
      ? { threadId: parsed.threadId, title: parsed.title }
      : null;
  } catch {
    return null;
  }
}

export function saveActiveComputerTurn(turn: ActiveComputerTurn | null): void {
  try {
    if (turn === null) sessionStorage.removeItem(ACTIVE_COMPUTER_TURN_KEY);
    else sessionStorage.setItem(ACTIVE_COMPUTER_TURN_KEY, JSON.stringify(turn));
  } catch {
    // The lease still lives in React state for the rest of this tab.
  }
}

export function migrateLegacyComputerUrl(
  url: URL,
  activeThreadId: string,
): { migrated: boolean; selectedThreadId: string | null; path: string } {
  const next = new URL(url.href);
  const migrated = next.searchParams.has(LEGACY_COMPUTER_PARAM);
  if (migrated) next.searchParams.delete(LEGACY_COMPUTER_PARAM);
  return {
    migrated,
    selectedThreadId: migrated ? activeThreadId : null,
    path: next.pathname + next.search + next.hash,
  };
}
