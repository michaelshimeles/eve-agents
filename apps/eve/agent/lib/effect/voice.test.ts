import { Effect, Exit } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceError, buildVoicePersona, mintVoiceClientSecret, transcribeAudioAttachment } from "./voice";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("buildVoicePersona", () => {
  it("includes identity, memory, time, and tool rules", () => {
    const persona = buildVoicePersona(
      { static: ["Lives in Toronto"], dynamic: ["Planning a trip"] },
      new Date("2026-07-27T18:14:00Z"),
      "Ruth",
      "Micky",
    );
    expect(persona).toContain("Ruth");
    expect(persona).toContain("Micky");
    expect(persona).toContain("Lives in Toronto");
    expect(persona).toContain("Planning a trip");
    expect(persona).toContain("ask_ruth");
    expect(persona).toContain("answer_ruth");
    expect(persona).not.toContain("undefined");
  });
  it("degrades gracefully without a memory profile", () => {
    const persona = buildVoicePersona(null, new Date(), "Ruth", "Micky");
    expect(persona).toContain("memory profile is unavailable");
  });
});

describe("mintVoiceClientSecret", () => {
  it("fails with not_configured when OPENAI_API_KEY is missing", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const exit = await Effect.runPromiseExit(mintVoiceClientSecret());
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("not_configured");
    }
  });
  it("returns the secret on a 200 from OpenAI", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      if (String(url).includes("client_secrets")) {
        return new Response(JSON.stringify({ value: "ek_test", expires_at: 1234, session: {} }), { status: 200 });
      }
      return new Response("{}", { status: 500 }); // memory profile call fails -> graceful null
    }));
    const secret = await Effect.runPromise(mintVoiceClientSecret());
    expect(secret.value).toBe("ek_test");
    expect(secret.expiresAt).toBe(1234);
    expect(secret.model).toBe("gpt-realtime");
  });
});

describe("transcribeAudioAttachment", () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);

  it("fails with not_configured when OPENAI_API_KEY is missing", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const exit = await Effect.runPromiseExit(transcribeAudioAttachment(bytes, "audio/m4a", "memo.m4a"));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("not_configured");
    }
  });

  it("fails without calling OpenAI when the attachment is too large", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const huge = new Uint8Array(21 * 1024 * 1024);
    const exit = await Effect.runPromiseExit(transcribeAudioAttachment(huge, "audio/m4a", "memo.m4a"));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns the transcript text on a 200 from OpenAI", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        expect(String(url)).toBe("https://api.openai.com/v1/audio/transcriptions");
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ text: "pick up milk on the way home" }), { status: 200 });
      }),
    );
    const transcript = await Effect.runPromise(transcribeAudioAttachment(bytes, "audio/m4a", "memo.m4a"));
    expect(transcript.text).toBe("pick up milk on the way home");
  });

  it("fails with the openai reason on a non-2xx response", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad file", { status: 400 })));
    const exit = await Effect.runPromiseExit(transcribeAudioAttachment(bytes, "audio/caf", "memo.caf"));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("openai");
    }
  });

  it("fails cleanly when OpenAI returns no text field", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
    const exit = await Effect.runPromiseExit(transcribeAudioAttachment(bytes, "audio/m4a", "memo.m4a"));
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("VoiceError", () => {
  it("carries reason and message", () => {
    const error = new VoiceError({ reason: "openai", message: "boom" });
    expect(error.reason).toBe("openai");
    expect(error.message).toBe("boom");
  });
});
