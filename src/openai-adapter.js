const MAX_TOOL_DESCRIPTION = 220;
const MAX_PROPERTY_DESCRIPTION = 120;
const MAX_SCHEMA_DEPTH = 3;

export function promptFromChat(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const toolSpecs = tools.map(normalizeTool).filter(Boolean);

  const transcript = messages
    .map((message) => {
      const role = message.role || "user";
      const content = normalizeContent(message.content);
      if (role === "tool") {
        return `tool_result(${message.tool_call_id || "unknown"}): ${content}`;
      }
      return `${role}: ${content}`;
    })
    .filter(Boolean)
    .join("\n\n");

  if (!toolSpecs.length) return transcript;

  return [
    transcript,
    "",
    "Available tools from caller as JSON schema:",
    JSON.stringify(toolSpecs, null, 2),
    "",
    "Use only tool names listed above. If a tool is needed, reply with strict JSON only:",
    '{"type":"tool_call","tool_calls":[{"id":"call_xxx","name":"tool_name","arguments":{}}]}',
    "Never call a tool that is not listed above, even if it appears in previous failed tool results.",
    "If no tool is needed, reply with strict JSON only:",
    '{"type":"final","content":"answer"}'
  ].join("\n");
}

export function completionResponse({ model, content, tools = [] }) {
  const message = toAssistantMessage(content, tools);
  return {
    id: `chatcmpl-trae-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || "trae-auto",
    choices: [
      {
        index: 0,
        message,
        finish_reason: message.tool_calls ? "tool_calls" : "stop"
      }
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

export function streamResponse(res, { model, content, tools = [] }) {
  const id = `chatcmpl-trae-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const message = toAssistantMessage(content, tools);
  if (message.tool_calls) {
    res.write(`data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant", tool_calls: message.tool_calls }, finish_reason: "tool_calls" }]
    })}\n\n`);
  } else {
    for (const chunk of split(message.content || "")) {
      res.write(`data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }]
      })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
    })}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function toAssistantMessage(content, tools = []) {
  const toolCalls = detectToolCalls(content, tools);
  if (toolCalls) {
    return {
      role: "assistant",
      content: null,
      tool_calls: toolCalls.map((call, index) => ({
        id: call.id || `call_${Date.now()}_${index}`,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments || {})
        }
      }))
    };
  }
  const unsupported = detectUnsupportedToolCalls(content, tools);
  if (unsupported.length) {
    return {
      role: "assistant",
      content: `Ignored unsupported tool call(s): ${unsupported.join(", ")}. Available tools for this request are: ${Array.from(allowedToolNames(tools)).join(", ") || "none"}.`
    };
  }
  return { role: "assistant", content: detectFinal(content) || content || "" };
}

function detectToolCalls(content, tools = []) {
  const parsed = parseJson(content);
  if (parsed?.type !== "tool_call" || !Array.isArray(parsed.tool_calls)) return null;
  const allowed = allowedToolNames(tools);
  if (!allowed.size) return null;
  const calls = parsed.tool_calls.filter((call) => call?.name && allowed.has(call.name));
  return calls.length ? calls : null;
}

function detectUnsupportedToolCalls(content, tools = []) {
  const parsed = parseJson(content);
  if (parsed?.type !== "tool_call" || !Array.isArray(parsed.tool_calls)) return [];
  const allowed = allowedToolNames(tools);
  if (!allowed.size) return parsed.tool_calls.map((call) => call?.name).filter(Boolean);
  return parsed.tool_calls
    .map((call) => call?.name)
    .filter((name) => name && !allowed.has(name));
}

function allowedToolNames(tools) {
  return new Set(
    (Array.isArray(tools) ? tools : [])
      .map((tool) => tool?.function?.name || tool?.name)
      .filter(Boolean)
  );
}

function detectFinal(content) {
  const parsed = parseJson(content);
  return parsed?.type === "final" && typeof parsed.content === "string" ? parsed.content : "";
}

function parseJson(content) {
  if (!content || typeof content !== "string") return null;
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : part?.text || part?.data?.content || ""))
    .filter(Boolean)
    .join("\n");
}

function normalizeTool(tool) {
  const fn = tool?.function || tool;
  if (!fn?.name) return null;
  return {
    name: fn.name,
    description: truncate(fn.description || "", MAX_TOOL_DESCRIPTION),
    parameters: compactSchema(fn.parameters || { type: "object", properties: {} })
  };
}

function compactSchema(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > MAX_SCHEMA_DEPTH) return {};
  const out = {};
  if (schema.type) out.type = schema.type;
  if (schema.description) out.description = truncate(schema.description, MAX_PROPERTY_DESCRIPTION);
  if (Array.isArray(schema.enum)) out.enum = schema.enum.slice(0, 30);
  if (Array.isArray(schema.required)) out.required = schema.required.slice(0, 50);
  if (schema.items) out.items = compactSchema(schema.items, depth + 1);
  if (schema.properties && typeof schema.properties === "object") {
    out.properties = {};
    for (const [key, value] of Object.entries(schema.properties).slice(0, 80)) {
      out.properties[key] = compactSchema(value, depth + 1);
    }
  }
  return out;
}

function truncate(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function split(text) {
  if (!text) return [""];
  const out = [];
  for (let i = 0; i < text.length; i += 200) out.push(text.slice(i, i + 200));
  return out;
}
