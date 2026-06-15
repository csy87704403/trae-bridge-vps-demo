import assert from "node:assert/strict";
import { completionResponse, promptFromChat } from "../src/openai-adapter.js";

const prompt = promptFromChat({
  messages: [
    { role: "user", content: "Read package.json" },
    { role: "tool", tool_call_id: "call_1", content: "ok" }
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a local file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"]
        }
      }
    }
  ]
});

assert.match(prompt, /Available tools/);
assert.match(prompt, /read_file/);
assert.match(prompt, /tool_result\(call_1\): ok/);
assert.ok(prompt.length < 1200);

const compactPrompt = promptFromChat({
  messages: [{ role: "user", content: "hi" }],
  tools: [
    {
      type: "function",
      function: {
        name: "ask",
        description: "x".repeat(1000),
        parameters: {
          type: "object",
          properties: {
            question: { type: "string", description: "y".repeat(1000) }
          },
          required: ["question"]
        }
      }
    }
  ]
});

assert.match(compactPrompt, /ask/);
assert.ok(compactPrompt.length < 1200);
assert.doesNotMatch(compactPrompt, /x{500}/);
assert.doesNotMatch(compactPrompt, /y{500}/);

const response = completionResponse({
  model: "trae-auto",
  content: JSON.stringify({
    type: "tool_call",
    tool_calls: [
      {
        id: "call_test",
        name: "read_file",
        arguments: { path: "package.json" }
      }
    ]
  })
});

assert.equal(response.choices[0].finish_reason, "tool_calls");
assert.equal(response.choices[0].message.tool_calls[0].function.name, "read_file");
assert.equal(response.choices[0].message.tool_calls[0].function.arguments, "{\"path\":\"package.json\"}");

console.log("adapter ok");
