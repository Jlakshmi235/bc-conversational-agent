import { proxyChatCompletion } from "./services/groq-proxy";
import {
  inferPendingConfirmation,
  retrieveKnowledge,
  type ConversationStage,
  type RiskResult,
} from "./services/knowledge";

export interface Env {
  GROQ_API_KEY: string;
  GROQ_MODEL?: string;
  LLM_PROXY_TOKEN?: string;
  LIVEAVATAR_API_KEY: string;
  LIVEAVATAR_AGENT_URL?: string;
  LITE_AGENT_SHARED_SECRET?: string;
}

function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

function requiredEnv(value: string | undefined, name: string) {
  if (!value || value === "replace_me") {
    throw new Error(
      `${name} is not configured. Add it to .dev.vars for local development or to ` +
        "Cloudflare Worker Settings > Variables and Secrets for the deployed app.",
    );
  }
  return value;
}

function groqRetryDelayMs(response: Response, message = "") {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(Math.ceil(retryAfter * 1_000), 30_000);
  }
  const match = message.match(/try again in\s+([\d.]+)s/i);
  if (!match) return 0;
  return Math.min(Math.ceil(Number(match[1]) * 1_000), 30_000);
}

function summarizeRisk(risk?: RiskResult) {
  if (!risk) return null;
  return {
    model: risk.model ?? "NCI BCRAT / Gail model",
    fiveYearRisk: risk.fiveYearRisk,
    lifetimeRisk: risk.lifetimeRisk,
  };
}

async function getLiveAvatarCredits(env: Env): Promise<Response> {
  try {
    const apiKey = requiredEnv(env.LIVEAVATAR_API_KEY, "LIVEAVATAR_API_KEY");
    const response = await fetch("https://api.liveavatar.com/v1/users/credits", {
      headers: { "X-API-KEY": apiKey },
    });
    const payload = (await response.json().catch(() => null)) as any;
    if (!response.ok) {
      return jsonError(payload?.message || payload?.error || "Unable to retrieve LiveAvatar credits.", response.status);
    }

    const remainingCredits = Number(payload?.data?.credits_left);
    if (!Number.isFinite(remainingCredits)) {
      return jsonError("LiveAvatar returned an unrecognized credits response.", 502);
    }

    return Response.json(
      { remainingCredits },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to retrieve LiveAvatar credits.", 500);
  }
}

async function calculateBreastCancerRisk(request: Request): Promise<Response> {
  const input = (await request.json().catch(() => null)) as
    | {
        currentAge?: number;
        projectionAge?: number;
        ageMen?: number;
        ageFirstBirth?: number;
        biopsies?: number;
        hyperplasia?: number;
        relatives?: number;
        race?: number;
      }
    | null;
  if (!input) return jsonError("Risk calculation inputs are required.");

  const currentAge = Number(input.currentAge);
  const projectionAge = Number(input.projectionAge);
  if (!Number.isFinite(currentAge) || currentAge < 35 || currentAge > 85) {
    return jsonError("Current age must be between 35 and 85.");
  }

  const raceMap: Record<number, { race: string; subRace: string }> = {
    1: { race: "White", subRace: "" },
    2: { race: "Black", subRace: "" },
    3: { race: "Hispanic", subRace: "US Hispanic" },
    4: { race: "Other", subRace: "" },
    5: { race: "Hispanic", subRace: "Foreign Hispanic" },
    6: { race: "Asian", subRace: "Chinese" },
    7: { race: "Asian", subRace: "Japanese" },
    8: { race: "Asian", subRace: "Filipino" },
    9: { race: "Asian", subRace: "Hawaiian" },
    10: { race: "Asian", subRace: "Islander" },
    11: { race: "Asian", subRace: "Asian" },
  };
  const race = raceMap[Number(input.race)];
  if (!race) return jsonError("Choose a supported race or ethnicity.");

  const biopsyCount = Number(input.biopsies);
  const biopsy = biopsyCount === 99 ? "99" : biopsyCount > 0 ? "1" : "0";
  const biopsyResult = biopsy === "1" ? String(Math.min(2, Math.max(1, biopsyCount))) : "";
  const hyperplasiaMap: Record<number, string> = { 0: ".93", 1: "1.82", 99: "1.0" };
  const ageMenMap: Record<number, string> = { 11: "2", 12: "1", 14: "0", 99: "0" };
  const firstBirthMap: Record<number, string> = { 19: "0", 22: "1", 27: "2", 30: "3", 98: "98", 99: "0" };

  const nciForm = new FormData();
  nciForm.set("cancerAndRadiationHistory", "1");
  nciForm.set("geneticMakeup", "1");
  nciForm.set("age", String(currentAge));
  nciForm.set("race", race.race);
  nciForm.set("sub_race", race.subRace);
  nciForm.set("biopsy", biopsy);
  nciForm.set("biopsy_result", biopsyResult);
  nciForm.set("biopsy_ah", biopsy === "1" ? hyperplasiaMap[Number(input.hyperplasia)] || "1.0" : "");
  nciForm.set("age_period", ageMenMap[Number(input.ageMen)] || "0");
  nciForm.set("childbirth_age", firstBirthMap[Number(input.ageFirstBirth)] || "0");
  nciForm.set("relatives", String(Number(input.relatives) === 99 ? 0 : Number(input.relatives)));

  try {
    const upstream = await fetch("https://bcrisktool.cancer.gov/calculate", {
      method: "POST",
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        Origin: "https://bcrisktool.cancer.gov",
        Referer: "https://bcrisktool.cancer.gov/calculator.html",
        "User-Agent": "Mozilla/5.0 Breast Risk Education Tool",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: nciForm,
    });
    const payload = (await upstream.json().catch(() => null)) as any;
    if (!upstream.ok || !payload?.success) {
      return jsonError(payload?.message || "The NCI risk calculator did not complete the calculation.", upstream.status || 502);
    }

    const result = JSON.parse(payload.message || "{}");
    return Response.json({
      success: true,
      model: "NCI BCRAT / Gail model, version 4.1",
      fiveYearRisk: {
        individualPercent: Number(result.risk),
        averagePercent: Number(result.averageFiveRisk),
        startAge: currentAge,
        endAge: Number.isFinite(projectionAge) ? projectionAge : currentAge + 5,
      },
      lifetimeRisk: {
        individualPercent: Number(result.lifetime_patient_risk),
        averagePercent: Number(result.lifetime_average_risk),
        startAge: currentAge,
        endAge: 90,
      },
    });
  } catch (error) {
    console.error("NCI risk calculation request failed", error);
    return jsonError("The NCI risk calculator is temporarily unavailable. Please try again.", 502);
  }
}

async function assembleKnowledge(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as
    | {
        riskResult?: RiskResult;
        stage?: ConversationStage;
        userMessage?: string;
      }
    | null;

  if (!body?.riskResult) return jsonError("riskResult is required.");

  try {
    const retrieval = retrieveKnowledge({
      riskResult: body.riskResult,
      stage: body.stage ?? "initial_explanation",
      userMessage: body.userMessage ?? "Explain my risk result.",
    });

    return Response.json({
      branch: retrieval.branch,
      stage: retrieval.stage,
      topics: retrieval.topics,
      moduleIds: retrieval.moduleIds,
      riskContext: retrieval.riskContext,
      knowledgeContext: retrieval.knowledgeContext,
      assembledSystemPrompt: retrieval.assembledSystemPrompt,
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to assemble knowledge.");
  }
}

async function groundedTextChat(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json().catch(() => null)) as
      | {
          riskResult?: RiskResult;
          messages?: Array<{ role: "user" | "assistant"; content: string }>;
          stage?: ConversationStage;
        }
      | null;

    if (!body?.riskResult) return jsonError("riskResult is required.");
    if (!body.messages?.length) return jsonError("messages are required.");

    // Only forward OpenAI-compatible message fields upstream.
    // Browser-side transcript objects may contain logging metadata such as
    // timestamps or retrieval module IDs, which Groq correctly rejects.
    const cleanMessages = body.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));
    // The risk result and retrieved clinical grounding are supplied separately,
    // so the entire transcript is not needed on every request. Limiting history
    // prevents old long answers from exhausting Groq's tokens-per-minute quota.
    const recentMessages = cleanMessages.slice(-6);

    const lastUserMessage = [...cleanMessages]
      .reverse()
      .find((message) => message.role === "user")?.content;
    if (!lastUserMessage) return jsonError("A user message is required.");
    const previousAssistantMessage = [...cleanMessages]
      .reverse()
      .find((message) => message.role === "assistant")?.content || "";

    const retrieval = retrieveKnowledge({
      riskResult: body.riskResult,
      stage: body.stage ?? "follow_up",
      userMessage: lastUserMessage,
      pendingConfirmation: inferPendingConfirmation(previousAssistantMessage),
    });

    const groqRequest = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requiredEnv(env.GROQ_API_KEY, "GROQ_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.GROQ_MODEL || "openai/gpt-oss-120b",
        temperature: 0.2,
        // Leave enough room to finish the explanation. The previous 320-token
        // cap could stop Groq in the middle of a sentence.
        max_tokens: 550,
        messages: [
          {
            role: "system",
            content: `${retrieval.assembledSystemPrompt}\n\n# Response length\nKeep the answer concise, normally under 500 tokens. Always finish the current sentence and closing thought.`,
          },
          ...recentMessages,
        ],
      }),
    };

    let upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", groqRequest);
    if (upstream.status === 429) {
      const rateLimitPayload = (await upstream.clone().json().catch(() => null)) as any;
      const delayMs = groqRetryDelayMs(upstream, rateLimitPayload?.error?.message || "");
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", groqRequest);
      }
    }

    const payload = (await upstream.json().catch(() => null)) as any;
    if (!upstream.ok) {
      return jsonError(payload?.error?.message || `Groq request failed (${upstream.status}).`, upstream.status);
    }

    return Response.json({
      reply: payload?.choices?.[0]?.message?.content || "",
      branch: retrieval.branch,
      moduleIds: retrieval.moduleIds,
      topics: retrieval.topics,
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to generate text response.", 500);
  }
}

async function createLiteLiveAvatarSession(request: Request, env: Env): Promise<Response> {
  try {
    const agentUrl = requiredEnv(env.LIVEAVATAR_AGENT_URL, "LIVEAVATAR_AGENT_URL").replace(/\/$/, "");
    const agentSecret = requiredEnv(env.LITE_AGENT_SHARED_SECRET, "LITE_AGENT_SHARED_SECRET");
    const body = (await request.json().catch(() => null)) as
      | { riskResult?: RiskResult; avatarKey?: "avatar-1" | "avatar-2" | "avatar-3" }
      | null;
    if (!body?.riskResult) return jsonError("riskResult is required.");

    const avatarKey = body.avatarKey || "avatar-1";
    const initialRetrieval = retrieveKnowledge({
      riskResult: body.riskResult,
      stage: "initial_explanation",
      userMessage: "Explain my breast cancer risk result.",
    });
    const systemPrompt = [
      initialRetrieval.assembledSystemPrompt,
      "# Machine-readable application state",
      "Keep this application state private and never quote its XML-like tag.",
      `<app_risk_json>${JSON.stringify(summarizeRisk(body.riskResult))}</app_risk_json>`,
    ].join("\n\n");

    const upstream = await fetch(`${agentUrl}/sessions`, {
      method: "POST",
      headers: {
        "X-Agent-Secret": agentSecret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        avatar_key: avatarKey,
        system_prompt: systemPrompt,
        opening_text:
          "Hi, I'm your virtual health educator. I'm here to help you understand your breast cancer risk results — this is not a diagnosis, and I'm not a clinician. Ready to start?",
      }),
    });
    const payload = (await upstream.json().catch(() => null)) as any;
    if (!upstream.ok) {
      return jsonError(
        payload?.detail || payload?.error || `LITE agent session failed (${upstream.status}).`,
        upstream.status,
      );
    }

    return Response.json({
      ...payload,
      riskBranch: initialRetrieval.branch,
      initialModules: initialRetrieval.moduleIds,
      riskResult: summarizeRisk(body.riskResult),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to create LITE session.", 500);
  }
}

async function stopLiteLiveAvatarSession(request: Request, env: Env): Promise<Response> {
  try {
    const agentUrl = requiredEnv(env.LIVEAVATAR_AGENT_URL, "LIVEAVATAR_AGENT_URL").replace(/\/$/, "");
    const agentSecret = requiredEnv(env.LITE_AGENT_SHARED_SECRET, "LITE_AGENT_SHARED_SECRET");
    const body = (await request.json().catch(() => null)) as { sessionId?: string } | null;
    if (!body?.sessionId) return jsonError("sessionId is required.");

    const upstream = await fetch(`${agentUrl}/sessions/${encodeURIComponent(body.sessionId)}`, {
      method: "DELETE",
      headers: { "X-Agent-Secret": agentSecret },
    });
    if (!upstream.ok && upstream.status !== 404) {
      const payload = (await upstream.json().catch(() => null)) as any;
      return jsonError(payload?.detail || `Unable to stop LITE agent session (${upstream.status}).`, upstream.status);
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to stop LITE session.", 500);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }

    if (url.pathname === "/api/calculate-risk" && request.method === "POST") {
      return calculateBreastCancerRisk(request);
    }

    if (url.pathname === "/api/knowledge/assemble" && request.method === "POST") {
      return assembleKnowledge(request);
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      return groundedTextChat(request, env);
    }

    if (url.pathname === "/api/liveavatar/credits" && request.method === "GET") {
      return getLiveAvatarCredits(env);
    }

    // OpenAI-compatible endpoint used by LiveAvatar's custom LLM configuration.
    if (url.pathname === "/openai/v1/chat/completions" && request.method === "POST") {
      return proxyChatCompletion(request, env);
    }

    if (url.pathname === "/api/liveavatar/session" && request.method === "POST") {
      return createLiteLiveAvatarSession(request, env);
    }

    if (url.pathname === "/api/liveavatar/session" && request.method === "DELETE") {
      return stopLiteLiveAvatarSession(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
