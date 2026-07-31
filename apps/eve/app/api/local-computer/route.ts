import {
  createLocalComputerPairTicket,
  disconnectLocalComputer,
  localComputerRelayStatus,
} from "@/agent/lib/effect/local-computer-relay";
import { runApp } from "@/agent/lib/effect/runtime";
import {
  directLocalComputerConfigured,
  localComputerRelayConfigured,
} from "@/agent/lib/local-computer-relay-url";
import {
  localComputerApiFailure,
  ruthLocalDownloadUrl,
} from "@/lib/local-computer-api";
import { requireWebAuth } from "@/lib/web-auth";

export async function GET(request: Request): Promise<Response> {
  const denied = await requireWebAuth(request);
  if (denied) return denied;
  try {
    const status = await runApp(localComputerRelayStatus());
    return Response.json({
      ...status,
      directConfigured: directLocalComputerConfigured(),
      pairingAvailable: localComputerRelayConfigured(),
      downloadUrl: "/api/local-computer/download",
    });
  } catch (error) {
    return localComputerApiFailure(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const denied = await requireWebAuth(request);
  if (denied) return denied;
  try {
    const ticket = await runApp(createLocalComputerPairTicket());
    const origin = new URL(request.url).origin;
    const pairUrl = new URL("ruth-local://pair");
    pairUrl.searchParams.set("server", origin);
    pairUrl.searchParams.set("ticket", ticket.id);
    pairUrl.searchParams.set("secret", ticket.secret);
    return Response.json({
      pairUrl: pairUrl.href,
      expiresAt: ticket.expiresAt,
      downloadUrl: "/api/local-computer/download",
    });
  } catch (error) {
    return localComputerApiFailure(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const denied = await requireWebAuth(request);
  if (denied) return denied;
  try {
    await runApp(disconnectLocalComputer());
    return new Response(null, { status: 204 });
  } catch (error) {
    return localComputerApiFailure(error);
  }
}

export const dynamic = "force-dynamic";
