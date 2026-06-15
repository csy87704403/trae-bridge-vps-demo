import assert from "node:assert/strict";
import { completionResponse, promptFromChat, toolsFromChat } from "../src/openai-adapter.js";

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
assert.ok(prompt.length < 2200);

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
assert.ok(compactPrompt.length < 2200);
assert.doesNotMatch(compactPrompt, /x{500}/);
assert.doesNotMatch(compactPrompt, /y{500}/);

const response = completionResponse({
  model: "trae-auto",
  tools: [
    {
      type: "function",
      function: { name: "read_file" }
    }
  ],
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

const unsupportedResponse = completionResponse({
  model: "trae-auto",
  tools: [
    {
      type: "function",
      function: { name: "read_file" }
    }
  ],
  content: JSON.stringify({
    type: "tool_call",
    tool_calls: [
      {
        id: "call_bad",
        name: "get_weather",
        arguments: { city: "Hangzhou" }
      }
    ]
  })
});

assert.equal(unsupportedResponse.choices[0].finish_reason, "stop");
assert.equal(unsupportedResponse.choices[0].message.tool_calls, undefined);
assert.match(unsupportedResponse.choices[0].message.content, /get_weather/);

const answerResponse = completionResponse({
  model: "trae-auto",
  content: 'JSON 1 2 3 { "answer": "hello\\nworld" }'
});

assert.equal(answerResponse.choices[0].finish_reason, "stop");
assert.equal(answerResponse.choices[0].message.content, "hello\nworld");

const looseToolResponse = completionResponse({
  model: "trae-auto",
  tools: [
    {
      type: "function",
      function: { name: "bash" }
    }
  ],
  content: JSON.stringify({
    name: "bash",
    arguments: { command: "echo hi" }
  })
});

assert.equal(looseToolResponse.choices[0].finish_reason, "tool_calls");
assert.equal(looseToolResponse.choices[0].message.tool_calls[0].function.name, "bash");

const inlineBody = {
  messages: [
    {
      role: "user",
      content: [
        "system: You are Reasonix",
        "user: Create 1.txt on the Desktop",
        "",
        "Available tools from caller as JSON schema:",
        JSON.stringify([
          {
            name: "bash",
            description: "Run a shell command",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"]
            }
          }
        ], null, 2)
      ].join("\n")
    }
  ]
};

assert.deepEqual(toolsFromChat(inlineBody).map((tool) => tool.name), ["bash"]);
const inlinePrompt = promptFromChat(inlineBody);
assert.match(inlinePrompt, /TOOL-CALL CONTRACT/);
assert.match(inlinePrompt, /Current user request:\nCreate 1.txt on the Desktop/);
assert.doesNotMatch(inlinePrompt, /system: You are Reasonix[\s\S]*Available tools from caller/);

console.log("adapter ok");
