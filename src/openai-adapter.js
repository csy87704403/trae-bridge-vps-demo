const MAX_TOOL_DESCRIPTION = 220;
const MAX_PROPERTY_DESCRIPTION = 120;
const MAX_SCHEMA_DEPTH = 3;

export function promptFromChat(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = toolsFromChat(body);
  const toolSpecs = tools.map(normalizeTool).filter(Boolean);
  const hasInlineTools = messages.some((message) => normalizeContent(message.content).includes("Available tools from caller as JSON schema:"));
  const latestUser = [...messages]
    .reverse()
    .find((message) => message?.role === "user")?.content;
  const latestUserText = extractLatestUserRequest(stripInlineToolSchema(normalizeContent(latestUser)));
  const actionRequired = needsToolCall(latestUserText);
  const preferredTools = preferredToolNames(toolSpecs);

  const transcript = messages
    .map((message) => {
      const role = message.role || "user";
      const rawContent = stripInlineToolSchema(normalizeContent(message.content));
      const content = hasInlineTools ? extractLatestUserRequest(rawContent) : rawContent;
      if (role === "tool") {
        return `tool_result(${message.tool_call_id || "unknown"}): ${content}`;
      }
      return `${role}: ${content}`;
    })
    .filter(Boolean)
    .join("\n\n");

  if (!toolSpecs.length) return transcript;

  if (actionRequired) {
    return [
      "TRAE BRIDGE TOOL-CALL CONTRACT:",
      "The caller can only consume an OpenAI-style tool call JSON object.",
      "The current user request requires using a caller-provided tool. A final answer is invalid for this request.",
      "Your entire response MUST be exactly one JSON object. Do not write Markdown, explanations, code fences, or prose outside JSON.",
      "Caller-provided tools run on the user's local machine through the third-party agent, not inside TRAE web. Do not claim you cannot access the user's desktop; request a tool_call.",
      "For Windows Desktop paths, use the local user's desktop path, for example $env:USERPROFILE\\Desktop or [Environment]::GetFolderPath('Desktop') when using PowerShell.",
      preferredTools.length ? `Prefer these listed tools when appropriate: ${preferredTools.join(", ")}.` : "",
      "",
      "Conversation:",
      transcript,
      "",
      "Available tools from caller as JSON schema:",
      JSON.stringify(toolSpecs, null, 2),
      "",
      "Return one tool_call JSON object now. The tool name must be one of the listed tools. Arguments must be real values for the current user request.",
      "JSON keys to use: type, tool_calls, id, name, arguments.",
      "",
      "Current user request:",
      latestUserText || "(none)"
    ].filter(Boolean).join("\n");
  }

  return [
    "TRAE BRIDGE OUTPUT CONTRACT:",
    "You are an OpenAI-compatible tool-call planner behind a bridge. The caller can only consume JSON.",
    "Your entire response MUST be exactly one JSON object. Do not write Markdown, explanations, or prose outside JSON.",
    "If the user asks for an action that needs local files, shell commands, browser automation, project inspection, external APIs, or any caller-provided capability, call a listed tool instead of describing that you can do it.",
    "Action verbs such as read, open, list, search, run, write, edit, create, delete, inspect, analyze the project, or use a tool usually require a tool_call.",
    "If no tool is needed, return a final JSON answer.",
    "Never copy placeholder values such as call_xxx, tool_name, arguments, or answer. Replace them with real values.",
    "",
    "Conversation:",
    transcript,
    "",
    "Available tools from caller as JSON schema:",
    JSON.stringify(toolSpecs, null, 2),
    "",
    "Tool-call JSON shape:",
    '{"type":"tool_call","tool_calls":[{"id":"call_001","name":"one_listed_tool_name","arguments":{"arg":"value"}}]}',
    "Never call a tool that is not listed above, even if it appears in previous failed tool results.",
    "For final answers, use JSON keys type=final and content=<your actual answer text>.",
    "",
    "Current user request:",
    latestUserText || "(none)",
    "Return exactly one JSON object now."
  ].join("\n");
}

export function toolsFromChat(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const directTools = Array.isArray(body?.tools) ? body.tools : [];
  const inlineTools = extractInlineTools(messages);
  const merged = new Map();
  for (const tool of [...directTools, ...inlineTools]) {
    const normalized = normalizeTool(tool);
    if (normalized?.name && !merged.has(normalized.name)) merged.set(normalized.name, normalized);
  }
  return Array.from(merged.values());
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
  return { role: "assistant", content: detectFinal(content) || cleanupAssistantText(content) || "" };
}

function detectToolCalls(content, tools = []) {
  const parsed = parseJson(content);
  const rawCalls = normalizeParsedToolCalls(parsed);
  if (!rawCalls.length) return null;
  const allowed = allowedToolNames(tools);
  if (!allowed.size) return null;
  const calls = rawCalls.filter((call) => call?.name && allowed.has(call.name));
  return calls.length ? calls : null;
}

function detectUnsupportedToolCalls(content, tools = []) {
  const parsed = parseJson(content);
  const rawCalls = normalizeParsedToolCalls(parsed);
  if (!rawCalls.length) return [];
  const allowed = allowedToolNames(tools);
  if (!allowed.size) return rawCalls.map((call) => call?.name).filter(Boolean);
  return rawCalls
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
  if (parsed?.type === "final" && typeof parsed.content === "string") return parsed.content;
  if (typeof parsed?.answer === "string") return parsed.answer;
  if (typeof parsed?.content === "string" && !parsed?.tool_calls) return parsed.content;
  if (typeof parsed?.message === "string" && !parsed?.tool_calls) return parsed.message;
  return "";
}

function normalizeParsedToolCalls(parsed) {
  if (!parsed || typeof parsed !== "object") return [];
  if (Array.isArray(parsed.tool_calls)) {
    return parsed.tool_calls.map(normalizeParsedToolCall).filter(Boolean);
  }
  if (parsed.tool_call) {
    const call = normalizeParsedToolCall(parsed.tool_call);
    return call ? [call] : [];
  }
  if (parsed.function_call) {
    const call = normalizeParsedToolCall(parsed.function_call);
    return call ? [call] : [];
  }
  if (parsed.name || parsed.tool || parsed.function) {
    const call = normalizeParsedToolCall(parsed);
    return call ? [call] : [];
  }
  return [];
}

function normalizeParsedToolCall(call) {
  if (!call || typeof call !== "object") return null;
  const name = call.name || call.tool || call.function?.name;
  if (!name) return null;
  return {
    id: call.id,
    name,
    arguments: call.arguments || call.args || call.function?.arguments || {}
  };
}

function cleanupAssistantText(content) {
  if (!content || typeof content !== "string") return "";
  return content
    .replace(/^```(?:json|JSON)?\s*/i, "")
    .replace(/```$/i, "")
    .replace(/^JSON\s+(?:\d+\s*)+/i, "")
    .trim();
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

function extractInlineTools(messages) {
  const tools = [];
  for (const message of messages) {
    const content = normalizeContent(message.content);
    for (const jsonText of findInlineToolJsonArrays(content)) {
      try {
        const parsed = JSON.parse(jsonText);
        if (Array.isArray(parsed)) tools.push(...parsed);
      } catch {}
    }
  }
  return tools;
}

function stripInlineToolSchema(content) {
  if (!content || typeof content !== "string") return "";
  const marker = "Available tools from caller as JSON schema:";
  const index = content.indexOf(marker);
  if (index < 0) return content;
  return content.slice(0, index).trim();
}

function extractLatestUserRequest(content) {
  const text = String(content || "").trim();
  const matches = Array.from(text.matchAll(/(?:^|\n)\s*user:\s*([\s\S]*?)(?=\n\s*(?:system|assistant|tool_result)\s*:|\n\s*\[loop guard\]|$)/gi));
  const last = matches.at(-1)?.[1]?.trim();
  return last || text;
}

function findInlineToolJsonArrays(content) {
  const marker = "Available tools from caller as JSON schema:";
  const out = [];
  let searchFrom = 0;
  while (searchFrom < content.length) {
    const markerIndex = content.indexOf(marker, searchFrom);
    if (markerIndex < 0) break;
    const arrayStart = content.indexOf("[", markerIndex + marker.length);
    if (arrayStart < 0) break;
    const arrayEnd = findBalancedEnd(content, arrayStart, "[", "]");
    if (arrayEnd < 0) break;
    out.push(content.slice(arrayStart, arrayEnd + 1));
    searchFrom = arrayEnd + 1;
  }
  return out;
}

function findBalancedEnd(text, start, openChar, closeChar) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let pos = start; pos < text.length; pos += 1) {
    const ch = text[pos];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === openChar) depth += 1;
    if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return pos;
    }
  }
  return -1;
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

function needsToolCall(text) {
  return /read|open|list|search|run|write|edit|create|delete|inspect|analy[sz]e|file|shell|command|browser|tool|\u8bfb\u53d6|\u6253\u5f00|\u5217\u51fa|\u641c\u7d22|\u8fd0\u884c|\u6267\u884c|\u5199\u5165|\u4fee\u6539|\u7f16\u8f91|\u521b\u5efa|\u65b0\u5efa|\u5220\u9664|\u68c0\u67e5|\u5206\u6790|\u6587\u4ef6|\u684c\u9762|\u547d\u4ee4|\u5de5\u5177/i.test(text || "");
}

function preferredToolNames(toolSpecs) {
  return toolSpecs
    .map((tool) => tool.name)
    .filter((name) => /bash|shell|command|powershell|edit|write|file|create|run/i.test(name))
    .slice(0, 8);
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
