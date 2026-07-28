import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { EmptyToolInput, toolSchema } from "./tool-schema";

describe("toolSchema", () => {
  it("projects an empty tool input as an object", () => {
    const schema = toolSchema(EmptyToolInput);

    expect(schema["~standard"].jsonSchema.input({ target: "draft-07" })).toEqual({
      type: "object",
      additionalProperties: false,
    });
  });

  it("accepts only an empty object for an empty tool input", async () => {
    const schema = toolSchema(EmptyToolInput);

    expect(await schema["~standard"].validate({})).toEqual({ value: {} });
    expect(await schema["~standard"].validate([])).toHaveProperty("issues");
    expect(await schema["~standard"].validate({ unexpected: true })).toHaveProperty("issues");
  });

  it("leaves non-empty struct projection unchanged", () => {
    const schema = toolSchema(Schema.Struct({ code: Schema.String }));

    expect(schema["~standard"].jsonSchema.input({ target: "draft-07" })).toEqual({
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
      additionalProperties: false,
    });
  });
});
