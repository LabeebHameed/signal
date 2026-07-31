import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildOpenAiAttempts, type LlmJsonRequest } from "./llm.ts";

const REQ: LlmJsonRequest = {
  system: "system prompt",
  user: "user prompt",
  schema: { type: "object" },
  schemaName: "verdicts",
};

Deno.test("buildOpenAiAttempts: degrades json_schema -> json_object -> no format, dropping temperature last", () => {
  const attempts = buildOpenAiAttempts(REQ);
  assertEquals(attempts.length, 4);
  assertEquals(attempts[0].response_format?.type, "json_schema");
  assertEquals(attempts[1].response_format?.type, "json_object");
  assertEquals(attempts[2].response_format, undefined);
  assertEquals(attempts[3].response_format, undefined);
});

Deno.test("buildOpenAiAttempts: every attempt but the last pins temperature to 0", () => {
  const attempts = buildOpenAiAttempts(REQ);
  assertEquals(attempts[0].temperature, 0);
  assertEquals(attempts[1].temperature, 0);
  assertEquals(attempts[2].temperature, 0);
  assertEquals(attempts[3].temperature, undefined);
});

Deno.test("buildOpenAiAttempts: the json_schema attempt carries the request's schema and schemaName", () => {
  const attempts = buildOpenAiAttempts(REQ);
  const jsonSchema = attempts[0].response_format?.json_schema as Record<string, unknown>;
  assertEquals(jsonSchema.name, "verdicts");
  assertEquals(jsonSchema.strict, true);
  assertEquals(jsonSchema.schema, REQ.schema);
});
