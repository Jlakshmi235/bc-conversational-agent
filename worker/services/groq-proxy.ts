import {
  inferPendingConfirmation,
  retrieveKnowledge,
  type ConversationStage,
  type RiskResult,
} from "./knowledge";

interface GroqProxyEnv {
  GROQ_API_KEY: string;
  GROQ_MODEL?: string;
  LLM_PROXY_TOKEN?: string;
}

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  [key: string]: unknown;
};

type ChatCompletionBody = {
  model?: string;
  messages?: ChatMessage[];
  temperature?: number;
  stream?: boolean;
  [key: string]: unknown;
};

function getLastUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "user" && typeof message.content === "string") return message.content;
  }
  return "";
}

function getLastAssistantMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "assistant" && typeof message.content === "string") return message.content;
  }
  return "";
}

function inferStage(messages: ChatMessage[]): ConversationStage {
  const userMessages = messages.filter((message) => message.role === "user");
  const last = getLastUserMessage(messages).toLowerCase();
  if (userMessages.length <= 1) return "initial_explanation";
  if (["thank you", "thanks", "that's all", "thats all", "done", "goodbye", "bye"].some((term) => last.includes(term))) {
    return "closing";
  }
  return "follow_up";
}

function extractTaggedJson<T>(messages: ChatMessage[], tag: string): T | null {
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
  for (const message of messages) {
    if (typeof message.content !== "string") continue;
    const match = message.content.match(pattern);
    if (!match) continue;
    try {
      return JSON.parse(match[1]) as T;
    } catch {
      return null;
    }
  }
  return null;
}

function extractTaggedText(messages: ChatMessage[], tag: string): string | null {
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
  for (const message of messages) {
    if (typeof message.content !== "string") continue;
    const match = message.content.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

function isAuthorized(request: Request, env: GroqProxyEnv): boolean {
  if (!env.LLM_PROXY_TOKEN) return true;
  const auth = request.headers.get("Authorization") || "";
  return auth === `Bearer ${env.LLM_PROXY_TOKEN}`;
}

const MAX_INTERACTIVE_RETRY_MS = 5_000;

function groqRetryDelayMs(response: Response, message = ""): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  const messageMatch = message.match(/try again in\s+([\d.]+)s/i);
  const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
    ? Math.ceil(retryAfter * 1_000)
    : messageMatch
      ? Math.ceil(Number(messageMatch[1]) * 1_000)
      : 0;
  // A short TPM window is worth retrying during a live turn. A TPD delay can
  // be hours, so return immediately and let the agent surface an error.
  return delayMs > 0 && delayMs <= MAX_INTERACTIVE_RETRY_MS ? delayMs : 0;
}

async function fetchGroq(body: Record<string, unknown>, apiKey: string): Promise<Response> {
  const request = () => fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  let response = await request();
  if (response.status !== 429) return response;

  const errorPayload = await response.clone().json().catch(() => null) as
    | { error?: { message?: string } }
    | null;
  const delayMs = groqRetryDelayMs(response, errorPayload?.error?.message || "");
  if (!delayMs) return response;

  console.warn(JSON.stringify({
    event: "groq_rate_limit_retry",
    delayMs,
    model: body.model,
  }));
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  response = await request();
  return response;
}

export async function proxyChatCompletion(request: Request, env: GroqProxyEnv): Promise<Response> {
  if (!isAuthorized(request, env)) {
    return Response.json({ error: { message: "Unauthorized LLM proxy request." } }, { status: 401 });
  }
  if (!env.GROQ_API_KEY || env.GROQ_API_KEY === "replace_me") {
    return Response.json({ error: { message: "GROQ_API_KEY is not configured." } }, { status: 500 });
  }

  const body = (await request.json().catch(() => null)) as ChatCompletionBody | null;
  if (!body?.messages?.length) {
    return Response.json({ error: { message: "messages are required." } }, { status: 400 });
  }

  // LiveAvatar context should include these hidden tags so every LLM turn contains
  // the application state needed for deterministic retrieval.
  const riskResult = extractTaggedJson<RiskResult>(body.messages, "app_risk_json");
  const taggedStage = extractTaggedText(body.messages, "conversation_stage") as ConversationStage | null;
  const stage = taggedStage || inferStage(body.messages);

  let messages = body.messages;
  let retrievalDebug: Record<string, unknown> | null = null;

  if (riskResult) {
    const retrieval = retrieveKnowledge({
      riskResult,
      stage: ["initial_explanation", "follow_up", "closing"].includes(stage) ? stage : "follow_up",
      userMessage: getLastUserMessage(body.messages),
      pendingConfirmation: inferPendingConfirmation(getLastAssistantMessage(body.messages)),
    });

    messages = [
      { role: "system", content: retrieval.assembledSystemPrompt },
      ...body.messages.filter((message) => message.role !== "system"),
    ];

    retrievalDebug = {
      branch: retrieval.branch,
      stage: retrieval.stage,
      topics: retrieval.topics,
      moduleIds: retrieval.moduleIds,
    };
  }

  const upstreamBody = {
    ...body,
    model: env.GROQ_MODEL || body.model || "openai/gpt-oss-120b",
    messages,
  };

  const upstream = await fetchGroq(upstreamBody, env.GROQ_API_KEY);

  // Preserve Groq's OpenAI-compatible response shape for LiveAvatar.
  const headers = new Headers(upstream.headers);
  headers.set("X-RAG-Applied", riskResult ? "true" : "false");
  if (retrievalDebug) headers.set("X-RAG-Modules", JSON.stringify(retrievalDebug));
  return new Response(upstream.body, { status: upstream.status, headers });
}
