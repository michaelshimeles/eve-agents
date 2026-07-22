import { gateway } from "ai";

export async function GET() {
  try {
    const { models } = await gateway.getAvailableModels();
    const language = models
      .filter((model) => (model.modelType ?? "language") === "language")
      .map((model) => ({ id: model.id, name: model.name }));
    return Response.json({ models: language });
  } catch {
    return Response.json({ models: [] });
  }
}
