import { describe, expect, it } from "vitest";

import {
  UnsafeDeploymentUrlError,
  isPublicNetworkAddress,
  pinnedLookup,
  validateDeploymentUrl,
} from "./security";

const publicDns = async () => [{ address: "76.76.21.21", family: 4 as const }];

describe("iMessage deployment URL security", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
  ])("rejects non-public address %s", (address) => {
    expect(isPublicNetworkAddress(address)).toBe(false);
  });

  it.each(["76.76.21.21", "8.8.8.8", "2606:4700:4700::1111"])(
    "accepts public address %s",
    (address) => {
      expect(isPublicNetworkAddress(address)).toBe(true);
    },
  );

  it("accepts an allowlisted HTTPS deployment and strips trailing slashes", async () => {
    await expect(
      validateDeploymentUrl("https://ruth-staging.vercel.app///", {
        allowedHosts: [".vercel.app"],
        allowInsecureLocal: false,
        resolve: publicDns,
      }),
    ).resolves.toBe("https://ruth-staging.vercel.app");
  });

  it.each([
    "http://ruth-staging.vercel.app",
    "https://localhost",
    "https://127.0.0.1",
    "https://ruth-staging.vercel.app?next=http://169.254.169.254",
    "https://user:pass@ruth-staging.vercel.app",
    "https://evil.example",
  ])("rejects unsafe callback %s", async (url) => {
    await expect(
      validateDeploymentUrl(url, {
        allowedHosts: [".vercel.app"],
        allowInsecureLocal: false,
        resolve: publicDns,
      }),
    ).rejects.toBeInstanceOf(UnsafeDeploymentUrlError);
  });

  it("rejects allowlisted names when any DNS answer is private", async () => {
    await expect(
      validateDeploymentUrl("https://ruth-staging.vercel.app", {
        allowedHosts: [".vercel.app"],
        allowInsecureLocal: false,
        resolve: async () => [
          { address: "76.76.21.21", family: 4 },
          { address: "10.0.0.4", family: 4 },
        ],
      }),
    ).rejects.toThrow(/non-public/);
  });

  it("pins the connection lookup to the already validated DNS answers", async () => {
    const lookup = pinnedLookup("ruth-staging.vercel.app", [
      { address: "76.76.21.21", family: 4 },
    ]);
    const result = await new Promise<{ address: string; family: number }>(
      (resolve, reject) => {
        lookup(
          "ruth-staging.vercel.app",
          { family: 4, all: false },
          (error, address, family) => {
            if (error !== null) return reject(error);
            if (typeof address !== "string") return reject(new Error("expected one address"));
            resolve({ address, family: family ?? 0 });
          },
        );
      },
    );
    expect(result).toEqual({ address: "76.76.21.21", family: 4 });
  });

  it("refuses a connector lookup for any hostname other than the validated host", async () => {
    const lookup = pinnedLookup("ruth-staging.vercel.app", [
      { address: "76.76.21.21", family: 4 },
    ]);
    await expect(
      new Promise((resolve, reject) => {
        lookup(
          "metadata.internal",
          { family: 4, all: false },
          (error, address) => (error === null ? resolve(address) : reject(error)),
        );
      }),
    ).rejects.toThrow(/unexpected hostname/);
  });

  it("permits local HTTP only behind the explicit development flag", async () => {
    await expect(
      validateDeploymentUrl("http://localhost:3000", {
        allowedHosts: [],
        allowInsecureLocal: true,
      }),
    ).resolves.toBe("http://localhost:3000");
  });

  it.each([
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.2:3000",
    "http://192.168.1.20:3000",
    "http://printer.local:3000",
  ])("still rejects non-loopback HTTP with the development flag: %s", async (url) => {
    await expect(
      validateDeploymentUrl(url, {
        allowedHosts: [],
        allowInsecureLocal: true,
      }),
    ).rejects.toBeInstanceOf(UnsafeDeploymentUrlError);
  });
});
