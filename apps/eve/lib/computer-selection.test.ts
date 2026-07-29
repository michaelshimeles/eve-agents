import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadActiveComputerTurn,
  migrateLegacyComputerUrl,
  saveActiveComputerTurn,
  transitionComputerSelection,
  type ComputerSelectionState,
} from "./computer-selection";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

const idleA: ComputerSelectionState = {
  selectedThreadId: "thread-a",
  activeTurn: null,
};

describe("computer selection transitions", () => {
  it("transfers idle selection from thread A to thread B", () => {
    const transition = transitionComputerSelection(idleA, {
      type: "request",
      threadId: "thread-b",
      title: "Thread B",
    });

    expect(transition.result).toEqual({ ok: true, selected: true });
    expect(transition.state).toEqual({
      selectedThreadId: "thread-b",
      activeTurn: null,
    });
  });

  it("rejects selection in B while A owns an active turn and returns A's title", () => {
    const activeA: ComputerSelectionState = {
      selectedThreadId: "thread-a",
      activeTurn: { threadId: "thread-a", title: "Research in A" },
    };
    const transition = transitionComputerSelection(activeA, {
      type: "request",
      threadId: "thread-b",
      title: "Thread B",
    });

    expect(transition.state).toBe(activeA);
    expect(transition.result).toEqual({
      ok: false,
      selected: false,
      conflict: { threadId: "thread-a", title: "Research in A" },
    });
  });

  it("releases A's turn while leaving A selected", () => {
    const activeA: ComputerSelectionState = {
      selectedThreadId: "thread-a",
      activeTurn: { threadId: "thread-a", title: "Thread A" },
    };
    const transition = transitionComputerSelection(activeA, {
      type: "turn-finished",
      threadId: "thread-a",
    });

    expect(transition.state).toEqual({
      selectedThreadId: "thread-a",
      activeTurn: null,
    });
  });

  it("does not let an active owner deselect itself", () => {
    const activeA: ComputerSelectionState = {
      selectedThreadId: "thread-a",
      activeTurn: { threadId: "thread-a", title: "Thread A" },
    };
    const transition = transitionComputerSelection(activeA, {
      type: "request",
      threadId: "thread-a",
      title: "Thread A",
    });

    expect(transition.state).toBe(activeA);
    expect(transition.result).toEqual({ ok: true, selected: true });
  });

  it("clears deleted selection but retains an active lease until settlement", () => {
    const activeA: ComputerSelectionState = {
      selectedThreadId: "thread-a",
      activeTurn: { threadId: "thread-a", title: "Thread A" },
    };
    const transition = transitionComputerSelection(activeA, {
      type: "thread-deleted",
      threadId: "thread-a",
    });

    expect(transition.state).toEqual({
      selectedThreadId: null,
      activeTurn: activeA.activeTurn,
    });

    expect(
      transitionComputerSelection(transition.state, {
        type: "turn-finished",
        threadId: "thread-a",
      }).state,
    ).toEqual({
      selectedThreadId: null,
      activeTurn: null,
    });
  });

  it("clears idle selection when its thread is deleted", () => {
    const transition = transitionComputerSelection(idleA, {
      type: "thread-deleted",
      threadId: "thread-a",
    });

    expect(transition.state).toEqual({
      selectedThreadId: null,
      activeTurn: null,
    });
  });
});

describe("active computer turn persistence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("restores a tab-local lease after reload and clears it on settlement", () => {
    vi.stubGlobal("sessionStorage", memoryStorage());
    const activeTurn = { threadId: "thread-a", title: "Thread A" };

    saveActiveComputerTurn(activeTurn);
    const restored = loadActiveComputerTurn();
    expect(restored).toEqual(activeTurn);
    expect(
      transitionComputerSelection(
        { selectedThreadId: "thread-a", activeTurn: restored },
        { type: "request", threadId: "thread-b", title: "Thread B" },
      ).result,
    ).toEqual({
      ok: false,
      selected: false,
      conflict: activeTurn,
    });

    saveActiveComputerTurn(null);
    expect(loadActiveComputerTurn()).toBeNull();
  });

  it("ignores malformed persisted leases", () => {
    const storage = memoryStorage();
    storage.setItem("eve-web-active-computer-turn", '{"threadId":"thread-a"}');
    vi.stubGlobal("sessionStorage", storage);

    expect(loadActiveComputerTurn()).toBeNull();
  });
});

describe("legacy computer URL migration", () => {
  it("assigns the active thread and removes only the legacy computer query", () => {
    const migration = migrateLegacyComputerUrl(
      new URL("https://ruth.test/?thread=thread-a&computer=1&desktop=1"),
      "thread-a",
    );

    expect(migration).toEqual({
      migrated: true,
      selectedThreadId: "thread-a",
      path: "/?thread=thread-a&desktop=1",
    });
  });

  it("leaves a current URL unchanged", () => {
    const migration = migrateLegacyComputerUrl(
      new URL("https://ruth.test/?thread=thread-b&desktop=1"),
      "thread-b",
    );

    expect(migration).toEqual({
      migrated: false,
      selectedThreadId: null,
      path: "/?thread=thread-b&desktop=1",
    });
  });
});
