import { enrollLocalComputer } from "@/agent/lib/effect/local-computer-relay";
import { runApp } from "@/agent/lib/effect/runtime";
import {
  localComputerApiFailure,
  stringField,
} from "@/lib/local-computer-api";

export async function POST(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const ticketId = stringField(body, "ticketId", 100);
  const ticketSecret = stringField(body, "ticketSecret", 200);
  const deviceId = stringField(body, "deviceId", 200);
  const deviceName = stringField(body, "deviceName", 200);
  const deviceTokenHash = stringField(body, "deviceTokenHash", 64);
  const platform = stringField(body, "platform", 20);
  const architecture = stringField(body, "architecture", 20);
  if (
    ticketId.length === 0 ||
    ticketSecret.length === 0 ||
    deviceId.length === 0 ||
    deviceName.length === 0 ||
    deviceTokenHash.length === 0 ||
    platform.length === 0 ||
    architecture.length === 0
  ) {
    return Response.json({ error: "Invalid enrollment payload." }, { status: 400 });
  }
  try {
    const device = await runApp(
      enrollLocalComputer({
        ticketId,
        ticketSecret,
        deviceId,
        deviceName,
        deviceTokenHash,
        platform,
        architecture,
      }),
    );
    return Response.json({ device });
  } catch (error) {
    return localComputerApiFailure(error);
  }
}

export const dynamic = "force-dynamic";
