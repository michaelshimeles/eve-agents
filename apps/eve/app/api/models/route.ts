import { gateway } from "ai";

export async function GET() {
  try {
    const { models } = await gateway.getAvailableModels();
    const language = models
      .filter((model) => (model.modelType ?? "language") === "language")
      .map((model) => ({
        id: model.id,
        name: model.name,
        description: model.description ?? null,
        pricing: model.pricing
          ? { input: model.pricing.input, output: model.pricing.output }
          : null,
      }));
    return Response.json({ models: language });
  } catch {
    return Response.json({ models: [] });
  }
}
