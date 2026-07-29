import { Schema } from "effect";

/**
 * Effect's object-only schema for tools that accept no parameters.
 * `Schema.Struct({})` also admits arrays and projects an object/array union.
 */
export const EmptyToolInput = Schema.Record(Schema.String, Schema.Never);

/**
 * Adapts an Effect Schema for eve's `defineTool({ inputSchema })`.
 *
 * eve accepts any Standard Schema that also implements the Standard JSON
 * Schema extension: the AI SDK calls `~standard.jsonSchema.input({ target:
 * "draft-07" })` to build the model-facing JSON Schema and
 * `~standard.validate` to decode tool-call arguments. Effect provides both
 * halves as separate wrappers; this composes them, so one schema does model
 * projection, runtime validation, and static typing of `execute`.
 */
export function toolSchema<S extends Schema.Constraint & Schema.ConstraintDecoder<unknown>>(
  schema: S,
) {
  return Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema));
}
