// Classification via any OpenAI-compatible Chat Completions endpoint
// (OpenAI, Azure-style proxies, OpenRouter, Ollama, LM Studio, vLLM, ...).

export const GROUP_COLORS = [
  "grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange",
];

const REQUEST_TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT =`You organize browser tabs into tab groups.
Given a tab's title, URL and an excerpt of its content, pick the best group for it.
Rules:
- If one of the existing groups fits, reuse its name EXACTLY.
- Otherwise invent a new short group name (1-3 words, Title Case), broad enough to hold similar tabs later.
- Choose a color from: ${GROUP_COLORS.join(", ")}.
Respond with ONLY a JSON object, no prose: {"group": "<name>", "color": "<color>"}`;

/**
 * @param {object} settings  from loadSettings()
 * @param {{title:string,url:string,description?:string,text?:string}} page
 * @param {string[]} existingGroups  group names already present in the window
 * @param {string[]} preferredCategories  optional user-defined names
 * @returns {Promise<{group:string,color:string}>}
 */
export async function classifyTab(settings, page, existingGroups, preferredCategories) {
  const userPrompt = [
    `Existing groups: ${existingGroups.length ? existingGroups.join(", ") : "(none)"}`,
    preferredCategories.length
      ? `Preferred group names (use one if it fits): ${preferredCategories.join(", ")}`
      : null,
    `Title: ${page.title}`,
    `URL: ${page.url}`,
    page.description ? `Description: ${page.description}` : null,
    page.text ? `Content excerpt:\n${page.text}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const endpoint = `${settings.apiBaseUrl.replace(/\/+$/, "")}/chat/completions`;
  const headers = { "Content-Type": "application/json" };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        model: settings.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      }),
    });
  } catch (err) {
    if (err.name === "TimeoutError") {
      throw new Error(`LLM request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM request failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM response had no message content");
  return parseClassification(content, existingGroups);
}

export function parseClassification(content, existingGroups = []) {
  // Tolerate code fences / extra prose: grab the first {...} block.
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Could not find JSON in LLM output: ${content.slice(0, 200)}`);

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    throw new Error(`Invalid JSON in LLM output: ${match[0].slice(0, 200)}`);
  }

  let group = String(parsed.group || "").trim().slice(0, 40);
  if (!group) throw new Error("LLM did not return a group name");

  // Snap to an existing group name if it matches case-insensitively.
  const existing = existingGroups.find((g) => g.toLowerCase() === group.toLowerCase());
  if (existing) group = existing;

  const color = GROUP_COLORS.includes(parsed.color) ? parsed.color : "grey";
  return { group, color };
}
