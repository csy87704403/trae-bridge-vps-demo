export function promptFromChat(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const toolNames = tools
    .map((tool) => tool?.function?.name || tool?.name)
    .filter(Boolean);

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

  if (!toolNames.length) return transcript;

  return [
    transcript,
    "",
    "Available tools from caller:",
    toolNames.map((name) => `- ${name}`).join("\n"),
    "",
    "If a tool is needed, reply with strict JSON only:",
    '{"type":"tool_call","tool_calls":[{"id":"call_xxx","name":"tool_name","arguments":{}}]}',
    "If no tool is needed, reply with strict JSON only:",
    '{"type":"final","content":"answer"}'
  ].join("\n");
}

export function completionResponse({ model, content }) {
  return {
    id: `chatcmpl-trae-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || "trae-auto",
    choices: [
      {
        index: 0,
        message: toAssistantMessage(content),
        finish_reason: detectToolCalls(content) ? "tool_calls" : "stop"
      }
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

export function streamResponse(res, { model, content }) {
  const id = `chatcmpl-trae-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const message = toAssistantMessage(content);
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

function toAssistantMessage(content) {
  const toolCalls = detectToolCalls(content);
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
  return { role: "assistant", content: detectFinal(content) || content || "" };
}

function detectToolCalls(content) {
  const parsed = parseJson(content);
  if (parsed?.type !== "tool_call" || !Array.isArray(parsed.tool_calls)) return null;
  return parsed.tool_calls.filter((call) => call?.name);
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

function split(text) {
  if (!text) return [""];
  const out = [];
  for (let i = 0; i < text.length; i += 200) out.push(text.slice(i, i + 200));
  return out;
}
