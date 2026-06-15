const baseUrl = process.env.BRIDGE_URL || "http://127.0.0.1:39280";
const runs = Number(process.env.RUNS || process.argv.find((arg) => arg.startsWith("--runs="))?.split("=")[1] || 3);

const cases = [
  {
    name: "chat_minimal",
    body: {
      model: "trae-auto",
      messages: [{ role: "user", content: "只回复 ok" }]
    }
  },
  {
    name: "tool_inline_minimal",
    body: {
      model: "trae-auto",
      messages: [
        {
          role: "user",
          content: [
            "user: 在桌面创建 1.txt",
            "",
            "Available tools from caller as JSON schema:",
            JSON.stringify([
              {
                name: "bash",
                description: "Run a shell command on the user's local machine.",
                parameters: {
                  type: "object",
                  properties: {
                    command: { type: "string", description: "Command to run." }
                  },
                  required: ["command"]
                }
              }
            ], null, 2)
          ].join("\n")
        }
      ]
    }
  }
];

const allResults = [];

for (const testCase of cases) {
  for (let index = 0; index < runs; index += 1) {
    const result = await runCase(testCase.name, testCase.body, index + 1);
    allResults.push(result);
    console.log(JSON.stringify(result));
    if (result.quotaExhausted) {
      console.error("TRAE quota appears exhausted; benchmark stopped early.");
      printSummary(allResults);
      process.exit(2);
    }
  }
}

printSummary(allResults);

async function runCase(name, body, run) {
  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer bench"
      },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    const ms = Date.now() - started;
    const parsed = safeJson(text);
    const choice = parsed?.choices?.[0];
    const content = choice?.message?.content || "";
    return {
      case: name,
      run,
      status: response.status,
      ms,
      finish_reason: choice?.finish_reason || "",
      tool_calls: choice?.message?.tool_calls?.map((call) => call.function?.name || call.name) || [],
      quotaExhausted: /额度已耗尽|quota|limit exhausted/i.test(text),
      preview: String(content || text).slice(0, 160)
    };
  } catch (error) {
    return {
      case: name,
      run,
      status: 0,
      ms: Date.now() - started,
      finish_reason: "",
      tool_calls: [],
      quotaExhausted: false,
      error: String(error?.message || error)
    };
  }
}

function printSummary(results) {
  const grouped = new Map();
  for (const result of results) {
    const items = grouped.get(result.case) || [];
    items.push(result);
    grouped.set(result.case, items);
  }
  const summary = Array.from(grouped.entries()).map(([name, items]) => {
    const values = items.map((item) => item.ms).sort((a, b) => a - b);
    return {
      case: name,
      runs: items.length,
      min_ms: values[0],
      median_ms: values[Math.floor(values.length / 2)],
      max_ms: values.at(-1),
      statuses: Array.from(new Set(items.map((item) => item.status))),
      finish_reasons: Array.from(new Set(items.map((item) => item.finish_reason).filter(Boolean)))
    };
  });
  console.log(JSON.stringify({ summary }, null, 2));
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
