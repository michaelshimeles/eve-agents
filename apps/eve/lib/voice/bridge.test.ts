import { describe, expect, it } from "vitest";
import type { HandleMessageStreamEvent } from "eve/client";
import {
  NarrationGate,
  NARRATION_GAP_MS,
  REUSE_WINDOW_MS,
  buildDispatchContext,
  describeHandshakeFailure,
  describeInputRequests,
  dispatchOutcome,
  filterDispatchEvents,
  finalReply,
  matchInputResponses,
  shouldReuseThread,
  syntheticAssistantEvents,
  syntheticUserEvents,
  toolPhrase,
  transcriptFromEvents,
  transcriptWindow,
  voiceThreadTitle,
} from "./bridge";

function ev(type: string, data: Record<string, unknown>): HandleMessageStreamEvent {
  return { type, data } as unknown as HandleMessageStreamEvent;
}

const entries = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ role: "user" as const, text: `u${i}`, at: i }));

describe("transcriptWindow", () => {
  it("returns entries after sinceIndex, capped from the tail", () => {
    expect(transcriptWindow(entries(10), 4).map((e) => e.text)).toEqual(["u4","u5","u6","u7","u8","u9"]);
    expect(transcriptWindow(entries(100), 0, 5).map((e) => e.text)).toEqual(["u95","u96","u97","u98","u99"]);
    expect(transcriptWindow(entries(3), 3)).toEqual([]);
  });
});

describe("NarrationGate", () => {
  it("allows first distinct tool, blocks repeats, enforces gap and cap", () => {
    const gate = new NarrationGate();
    expect(gate.shouldNarrate("email_search", 1_000, false)).toBe(true);
    expect(gate.shouldNarrate("email_search", 60_000, false)).toBe(false); // repeat tool
    expect(gate.shouldNarrate("browser__goto", 1_000 + NARRATION_GAP_MS - 1, false)).toBe(false); // too soon
    expect(gate.shouldNarrate("browser__goto", 1_000 + NARRATION_GAP_MS, false)).toBe(true);
    expect(gate.shouldNarrate("computer_task", 999_000, true)).toBe(false); // user speaking
    expect(gate.shouldNarrate("computer_task", 999_000, false)).toBe(true); // 3rd narration
    expect(gate.shouldNarrate("another_tool", 9_999_000, false)).toBe(false); // cap reached
    gate.reset();
    expect(gate.shouldNarrate("email_search", 1, false)).toBe(true);
  });
});

describe("finalReply / dispatchOutcome", () => {
  const events = [
    ev("message.completed", { finishReason: "tool-calls", message: "Let me check.", sequence: 1, stepIndex: 0, turnId: "t1" }),
    ev("action.result", { result: { kind: "tool-result", callId: "c1", toolName: "x", output: {} }, sequence: 2, stepIndex: 0, status: "completed", turnId: "t1" }),
    ev("message.completed", { finishReason: "stop", message: "Done: two meetings.", sequence: 3, stepIndex: 1, turnId: "t1" }),
    ev("turn.completed", { sequence: 4, turnId: "t1" }),
  ];
  it("skips interim tool-calls text", () => {
    expect(finalReply(events)).toBe("Done: two meetings.");
  });
  it("reports parked input requests", () => {
    const parked = dispatchOutcome([
      ev("input.requested", { requests: [{ requestId: "r1", prompt: "Approve $20?", options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }], action: { callId: "c", toolName: "pay", kind: "tool-call", input: {} } }], sequence: 1, stepIndex: 0, turnId: "t1" }),
    ]);
    expect(parked.parked).toHaveLength(1);
    expect(parked.reply).toBeNull();
  });
  it("reports failures", () => {
    const out = dispatchOutcome([ev("turn.failed", { code: "x", message: "boom", sequence: 1, turnId: "t1" })]);
    expect(out.failure).toBe("boom");
  });
  it("surfaces a connection waiting on authorization instead of a false success", () => {
    const out = dispatchOutcome([
      ev("authorization.required", { description: "Connect Gmail", name: "gmail", sequence: 1, stepIndex: 0, turnId: "t1" }),
    ]);
    expect(out.authorization).toBe("gmail");
    expect(out.reply).toBeNull();
  });
  it("clears the authorization once it completes or the turn finishes", () => {
    const completed = dispatchOutcome([
      ev("authorization.required", { description: "d", name: "gmail", sequence: 1, stepIndex: 0, turnId: "t1" }),
      ev("authorization.completed", { name: "gmail", outcome: "authorized", sequence: 2, stepIndex: 0, turnId: "t1" }),
    ]);
    expect(completed.authorization).toBeNull();
    const finished = dispatchOutcome([
      ev("authorization.required", { description: "d", name: "gmail", sequence: 1, stepIndex: 0, turnId: "t1" }),
      ev("turn.completed", { sequence: 2, turnId: "t1" }),
    ]);
    expect(finished.authorization).toBeNull();
  });
});

describe("matchInputResponses", () => {
  const approval = { requestId: "r1", prompt: "Approve?", options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }], action: { callId: "c", toolName: "pay", kind: "tool-call" as const, input: {} } };
  it("maps spoken yes/no to approve/deny", () => {
    expect(matchInputResponses([approval], "yeah go ahead")).toEqual([{ requestId: "r1", optionId: "approve" }]);
    expect(matchInputResponses([approval], "no, cancel that")).toEqual([{ requestId: "r1", optionId: "deny" }]);
  });
  it("matches option labels", () => {
    const pick = { ...approval, options: [{ id: "a", label: "Tuesday" }, { id: "b", label: "Wednesday" }] };
    expect(matchInputResponses([pick], "wednesday works")).toEqual([{ requestId: "r1", optionId: "b" }]);
  });
  it("falls back to free text", () => {
    expect(matchInputResponses([{ ...approval, options: undefined }], "make it 9pm")).toEqual([{ requestId: "r1", text: "make it 9pm" }]);
  });
  it("approves when the user approves an action that is itself a cancellation", () => {
    expect(matchInputResponses([approval], "yes, cancel it")).toEqual([{ requestId: "r1", optionId: "approve" }]);
    expect(matchInputResponses([approval], "yeah stop the subscription")).toEqual([{ requestId: "r1", optionId: "approve" }]);
  });
  it("still denies genuine negations", () => {
    expect(matchInputResponses([approval], "don't do it")).toEqual([{ requestId: "r1", optionId: "deny" }]);
    expect(matchInputResponses([approval], "no, go ahead and skip it")).toEqual([{ requestId: "r1", optionId: "deny" }]);
    expect(matchInputResponses([approval], "never mind")).toEqual([{ requestId: "r1", optionId: "deny" }]);
  });
});

describe("synthetic events + filtering", () => {
  it("builds a renderable user/assistant exchange", () => {
    const user = syntheticUserEvents("hi", "v1", 1);
    expect(user[0].type).toBe("message.received");
    const assistant = syntheticAssistantEvents("hello!", "v2", 2);
    expect(assistant.map((e) => e.type)).toEqual(["message.completed", "turn.completed"]);
  });
  it("filterDispatchEvents drops session boundaries and live prompts", () => {
    const kept = filterDispatchEvents([
      ev("session.started", {}), ev("turn.started", { sequence: 0, turnId: "t" }),
      ev("input.requested", { requests: [], sequence: 1, stepIndex: 0, turnId: "t" }),
      ev("authorization.required", { description: "x", name: "y", sequence: 2, stepIndex: 0, turnId: "t" }),
      ev("session.waiting", { continuationToken: "x", wait: "next-user-message" }),
    ]);
    expect(kept.map((e) => e.type)).toEqual(["turn.started"]);
  });
  it("transcriptFromEvents rebuilds entries from persisted events", () => {
    const rebuilt = transcriptFromEvents([
      ev("message.received", { message: "hi", sequence: 1, turnId: "a" }),
      ev("message.completed", { finishReason: "tool-calls", message: "hold on", sequence: 2, stepIndex: 0, turnId: "a" }),
      ev("message.completed", { finishReason: "stop", message: "hello!", sequence: 3, stepIndex: 1, turnId: "a" }),
    ]);
    expect(rebuilt).toEqual([
      { role: "user", text: "hi", at: 0 },
      { role: "assistant", text: "hello!", at: 0 },
    ]);
  });
});

describe("describeHandshakeFailure", () => {
  it("names an unfunded account rather than echoing the status", () => {
    const body = JSON.stringify({ error: { code: "insufficient_quota", message: "You exceeded your current quota" } });
    expect(describeHandshakeFailure(429, body)).toContain("out of credit");
  });
  it("separates rate limiting from quota", () => {
    expect(describeHandshakeFailure(429, "{}")).toContain("rate limiting");
  });
  it("reports rejected keys and falls back to the status", () => {
    expect(describeHandshakeFailure(401, "{}")).toContain("rejected");
    expect(describeHandshakeFailure(500, "not json")).toBe("Voice connection failed (500)");
  });
});

describe("misc", () => {
  it("toolPhrase humanizes unknown tools", () => {
    expect(toolPhrase("query_receipts")).toBe("using query receipts");
    expect(toolPhrase("computer_task")).toBe("working on her computer");
  });
  it("voiceThreadTitle formats", () => {
    expect(voiceThreadTitle(new Date("2026-07-27T18:14:00Z"))).toMatch(/^Voice — /);
  });
  it("shouldReuseThread respects the 30-minute window", () => {
    const record = { threadId: "t", title: "Voice", endedAt: 1_000_000 };
    expect(shouldReuseThread(record, 1_000_000 + REUSE_WINDOW_MS - 1)).toBe(true);
    expect(shouldReuseThread(record, 1_000_000 + REUSE_WINDOW_MS)).toBe(false);
    expect(shouldReuseThread(null, 0)).toBe(false);
  });
  it("buildDispatchContext carries the voice flag and transcript", () => {
    const ctx = buildDispatchContext([{ role: "user", text: "hi", at: 0 }], "Ruth");
    expect(ctx.eveWebVoice).toBe(true);
    expect(ctx.voiceTranscript).toBe("User: hi");
    expect(typeof ctx.clientTime).toBe("string");
  });
  it("describeInputRequests reads prompts and options aloud", () => {
    expect(describeInputRequests([{ requestId: "r", prompt: "Approve $20?", options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }], action: { callId: "c", toolName: "p", kind: "tool-call", input: {} } }])).toBe("Approve $20? (options: Approve, Deny)");
  });
});
