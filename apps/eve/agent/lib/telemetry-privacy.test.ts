import { describe, expect, it } from "vitest";

import { shouldRecordTelemetryIo } from "./telemetry-privacy";

describe("telemetry body privacy", () => {
  it("keeps ordinary I/O recording opt-in behavior when Agentcard is absent", () => {
    expect(shouldRecordTelemetryIo({})).toBe(true);
    expect(shouldRecordTelemetryIo({ OTEL_RECORD_IO: "false" })).toBe(false);
  });

  it("suppresses every trace body when Agentcard can return PAN/CVV", () => {
    expect(
      shouldRecordTelemetryIo({
        OTEL_RECORD_IO: "true",
        AGENTCARD_CLIENT_ID: "cl_1",
        AGENTCARD_CLIENT_SECRET: "secret_1",
      }),
    ).toBe(false);
  });

  it("suppresses trace bodies on router, deployment, and Advanced iMessage nodes", () => {
    expect(
      shouldRecordTelemetryIo({
        OTEL_RECORD_IO: "true",
        IMESSAGE_ROUTER_URL: "https://router.example",
      }),
    ).toBe(false);
    expect(
      shouldRecordTelemetryIo({
        OTEL_RECORD_IO: "true",
        SPECTRUM_PROJECT_ID: "spectrum-project",
      }),
    ).toBe(false);
    expect(
      shouldRecordTelemetryIo({
        OTEL_RECORD_IO: "true",
        PHOTON_ADVANCED_IMESSAGE_ADDRESS: "imessage.example:443",
      }),
    ).toBe(false);
  });
});
