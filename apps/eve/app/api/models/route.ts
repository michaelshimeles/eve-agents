import {
  FALLBACK_DEFAULT_MODEL_ID,
  getGatewayModelCatalog,
} from "@/agent/lib/gateway-models";

export async function GET() {
  try {
    const catalog = await getGatewayModelCatalog();
    return Response.json({
      models: catalog.models,
      defaultModel: catalog.defaultModel,
    });
  } catch {
    // Picker shows "unavailable" when models is empty; keep a default so a
    // saved selection can still fall back cleanly.
    return Response.json({
      models: [],
      defaultModel: FALLBACK_DEFAULT_MODEL_ID,
    });
  }
}
