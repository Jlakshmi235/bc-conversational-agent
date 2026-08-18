import systemPromptRaw from "../../prompts/system-prompt.md?raw";
import scopeSafetyRaw from "../../knowledge/modules/00_scope-and-safety.md?raw";
import explainRiskRaw from "../../knowledge/modules/01_explain-risk.md?raw";
import understandingRaw from "../../knowledge/modules/02_understanding-and-concerns.md?raw";
import limitationsRaw from "../../knowledge/modules/03_gail-limitations.md?raw";
import lowAverageRaw from "../../knowledge/modules/04_low-average-risk-pathway.md?raw";
import elevatedRaw from "../../knowledge/modules/05_elevated-risk-pathway.md?raw";
import clinicianDiscussionRaw from "../../knowledge/modules/06_clinical-discussion.md?raw";

export type RiskBranch = "low-average" | "elevated";
export type ConversationStage = "initial_explanation" | "follow_up" | "closing";
export type KnowledgeTopic =
  | "risk_explanation"
  | "understanding"
  | "concerns"
  | "model_limitations"
  | "risk_factors"
  | "family_history"
  | "next_steps"
  | "clinician_discussion";

export interface RiskResult {
  model?: string;
  fiveYearRisk?: {
    individualPercent?: number;
    averagePercent?: number;
    startAge?: number;
    endAge?: number;
  };
  lifetimeRisk?: {
    individualPercent?: number;
    averagePercent?: number;
    startAge?: number;
    endAge?: number;
  };
}

interface KnowledgeModule {
  id: string;
  alwaysInclude: boolean;
  stages: ConversationStage[];
  branches: RiskBranch[];
  topics: KnowledgeTopic[];
  content: string;
}

function stripFrontMatter(markdown: string): string {
  return markdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "").trim();
}

const MODULES: KnowledgeModule[] = [
  {
    id: "scope-and-safety",
    alwaysInclude: true,
    stages: ["initial_explanation", "follow_up", "closing"],
    branches: ["low-average", "elevated"],
    topics: [],
    content: stripFrontMatter(scopeSafetyRaw),
  },
  {
    id: "explain-risk",
    alwaysInclude: false,
    stages: ["initial_explanation"],
    branches: ["low-average", "elevated"],
    topics: ["risk_explanation"],
    content: stripFrontMatter(explainRiskRaw),
  },
  {
    id: "understanding-and-concerns",
    alwaysInclude: false,
    stages: ["follow_up"],
    branches: ["low-average", "elevated"],
    topics: ["understanding", "concerns", "risk_explanation"],
    content: stripFrontMatter(understandingRaw),
  },
  {
    id: "gail-limitations",
    alwaysInclude: false,
    stages: ["follow_up"],
    branches: ["low-average", "elevated"],
    topics: ["model_limitations", "risk_factors", "family_history"],
    content: stripFrontMatter(limitationsRaw),
  },
  {
    id: "low-average-risk-pathway",
    alwaysInclude: false,
    stages: ["initial_explanation", "follow_up", "closing"],
    branches: ["low-average"],
    // Deliberately excludes "next_steps" and "clinician_discussion" — that
    // content belongs to clinical-discussion, which is the single source
    // for follow-up "what do I do next" style turns. Keeping only
    // risk_explanation here means this module only re-fires on a later
    // turn if the user is revisiting the classification itself, not every
    // time they ask about next steps.
    topics: ["risk_explanation"],
    content: stripFrontMatter(lowAverageRaw),
  },
  {
    id: "elevated-risk-pathway",
    alwaysInclude: false,
    stages: ["initial_explanation", "follow_up", "closing"],
    branches: ["elevated"],
    // Same reasoning as low-average-risk-pathway above: next_steps and
    // clinician_discussion belong to clinical-discussion, not here.
    topics: ["risk_explanation"],
    content: stripFrontMatter(elevatedRaw),
  },
  {
    id: "clinical-discussion",
    alwaysInclude: false,
    stages: ["follow_up", "closing"],
    branches: ["low-average", "elevated"],
    topics: ["clinician_discussion", "next_steps", "family_history"],
    content: stripFrontMatter(clinicianDiscussionRaw),
  },
];

function containsAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

export function inferTopics(userMessage = ""): KnowledgeTopic[] {
  const text = userMessage.toLowerCase();
  const topics = new Set<KnowledgeTopic>();

  if (!text.trim()) topics.add("risk_explanation");

  if (containsAny(text, ["what does", "mean", "explain", "percentage", "percent", "average", "risk"])) {
    topics.add("risk_explanation");
  }
  if (containsAny(text, ["confus", "understand", "don't get", "dont get", "unclear"])) {
    topics.add("understanding");
  }
  if (containsAny(text, ["worried", "worry", "scared", "afraid", "anxious", "concerned", "concern"])) {
    topics.add("concerns");
  }
  if (containsAny(text, ["limitation", "accurate", "accuracy", "leave out", "include", "model", "gail", "bcrat"])) {
    topics.add("model_limitations");
  }
  if (containsAny(text, ["factor", "why is my risk", "why higher", "why lower", "biopsy", "period", "birth", "race", "ethnicity"])) {
    topics.add("risk_factors");
  }
  if (containsAny(text, ["family", "mother", "sister", "daughter", "relative", "brca", "genetic"])) {
    topics.add("family_history");
  }
  if (containsAny(text, ["next", "do now", "what should i do", "follow up", "follow-up"])) {
    topics.add("next_steps");
  }
  if (containsAny(text, ["doctor", "clinician", "provider", "appointment", "visit", "ask", "screen", "mammogram", "mri", "testing"])) {
    topics.add("clinician_discussion");
  }

  if (topics.size === 0) topics.add("understanding");
  return [...topics];
}

export function selectRiskBranch(risk: RiskResult): RiskBranch {
  const fiveYearRisk = Number(risk.fiveYearRisk?.individualPercent);
  const lifetimeRisk = Number(risk.lifetimeRisk?.individualPercent);

  if (!Number.isFinite(fiveYearRisk) || !Number.isFinite(lifetimeRisk)) {
    throw new Error(
      "Numeric five-year and lifetime individual risks are required to select the application risk branch."
    );
  }

  // Low-average only when BOTH conditions are met (lifetime < 20% AND
  // 5-year < 1.67%). Otherwise elevated. 1.67% matches the standard
  // BCRAT/Gail 5-year elevated-risk threshold used consistently across
  // every knowledge module and the system prompt — keep this in sync if
  // either changes.
  if (lifetimeRisk < 20 && fiveYearRisk < 1.67) {
    return "low-average";
  }

  return "elevated";
}

export function formatRiskContext(risk: RiskResult, branch: RiskBranch): string {
  const f = risk.fiveYearRisk;
  const l = risk.lifetimeRisk;
  return [
    "# Application-supplied patient risk context",
    `Risk branch selected by the application: ${branch}`,
    `Model: ${risk.model ?? "NCI BCRAT / Gail model"}`,
    `5-year individual risk: ${f?.individualPercent ?? "unknown"}%`,
    `5-year population comparison: ${f?.averagePercent ?? "unknown"}%`,
    `5-year age range: ${f?.startAge ?? "unknown"}-${f?.endAge ?? "unknown"}`,
    `Lifetime individual risk: ${l?.individualPercent ?? "unknown"}%`,
    `Lifetime population comparison: ${l?.averagePercent ?? "unknown"}%`,
    `Lifetime age range: ${l?.startAge ?? "unknown"}-${l?.endAge ?? "unknown"}`,
    "The LLM must use this branch as supplied and must not recalculate or override it.",
  ].join("\n");
}

export interface RetrievalInput {
  riskResult: RiskResult;
  stage?: ConversationStage;
  userMessage?: string;
  topics?: KnowledgeTopic[];
}

export interface RetrievalResult {
  branch: RiskBranch;
  stage: ConversationStage;
  topics: KnowledgeTopic[];
  moduleIds: string[];
  systemPrompt: string;
  riskContext: string;
  knowledgeContext: string;
  assembledSystemPrompt: string;
}

export function retrieveKnowledge(input: RetrievalInput): RetrievalResult {
  const stage = input.stage ?? "initial_explanation";
  const branch = selectRiskBranch(input.riskResult);
  const topics = input.topics?.length ? input.topics : inferTopics(input.userMessage);

  const selected = MODULES.filter((module) => {
    if (module.alwaysInclude) return true;
    if (!module.stages.includes(stage)) return false;
    if (!module.branches.includes(branch)) return false;

    // The branch-specific pathway is force-included only at the first
    // explanation turn, where it must deliver the classification and
    // required messages regardless of inferred topics. On later turns it
    // only re-fires through the normal topic match below (e.g., the user
    // is genuinely re-asking about the classification) — this stops the
    // full pathway script, including its own cue to action, from being
    // re-included and restated on every follow-up turn once
    // clinical-discussion has already taken over "what's next" content.
    if (module.id === `${branch}-risk-pathway` && stage === "initial_explanation") {
      return true;
    }

    return module.topics.some((topic) => topics.includes(topic));
  });

  const riskContext = formatRiskContext(input.riskResult, branch);
  const knowledgeContext = selected
    .map((module) => `\n## Retrieved module: ${module.id}\n${module.content}`)
    .join("\n");

  const systemPrompt = stripFrontMatter(systemPromptRaw);
  const assembledSystemPrompt = [
    systemPrompt,
    riskContext,
    "# Retrieved knowledge modules",
    knowledgeContext,
    "# Retrieval instruction",
    "Answer only from the application risk context and retrieved modules above. If the requested information is not supported there, say that this educator does not have enough grounded information and redirect appropriately.",
  ].join("\n\n");

  return {
    branch,
    stage,
    topics,
    moduleIds: selected.map((module) => module.id),
    systemPrompt,
    riskContext,
    knowledgeContext,
    assembledSystemPrompt,
  };
}
