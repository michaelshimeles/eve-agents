import { Effect, Exit } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceError, buildVoicePersona, mintVoiceClientSecret } from "./voice";

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
