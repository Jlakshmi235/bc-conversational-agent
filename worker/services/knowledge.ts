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
  | "clinician_discussion"
  | "confirmed_understanding"
  | "screening_guidance";

// The app must track which confirmation question the assistant most
// recently asked and pass it back on the next turn. Plain "yes"/"no"
// replies are ambiguous without this — "yes" means something different
// after "did that make sense?" than after "want a few questions for your
// doctor?" — and the app is the only thing that knows which one was asked.
export type PendingConfirmation = "understanding" | "doctor_questions";

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
    // No "initial_explanation" — this module must not fire until the user
    // has confirmed they understood the risk explanation. See
    // confirmed_understanding below. screening_guidance lets this module
    // re-fire later in the conversation if the user separately asks about
    // screening or treatment (its content includes the USPSTF general
    // guideline, gated behind the individualization caveat).
    stages: ["follow_up", "closing"],
    branches: ["low-average"],
    topics: ["risk_explanation", "confirmed_understanding", "screening_guidance"],
    content: stripFrontMatter(lowAverageRaw),
  },
  {
    id: "elevated-risk-pathway",
    alwaysInclude: false,
    stages: ["follow_up", "closing"],
    branches: ["elevated"],
    topics: ["risk_explanation", "confirmed_understanding", "screening_guidance"],
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

// Whole-message match only — deliberately not a substring check, so a
// longer message that happens to contain "yes" somewhere isn't swept into
// this branch. Bare confirmations are short by nature.
const AFFIRMATIVE = /^(yes|yeah|yep|yup|sure|ok|okay|got it|that makes sense|makes sense|understood|i understand|i think so|that helps|sounds good)[.,!]?$/;
const NEGATIVE = /^(no|nah|not really|not quite|not really understand|i don'?t|no thanks|not right now)[.,!]?$/;

export function inferTopics(
  userMessage = "",
  pendingConfirmation?: PendingConfirmation
): KnowledgeTopic[] {
  const text = userMessage.toLowerCase().trim();
  const topics = new Set<KnowledgeTopic>();

  if (!text) {
    topics.add("risk_explanation");
    return [...topics];
  }

  // Disambiguate bare "yes"/"no" using what the assistant just asked.
  // Without pendingConfirmation, "yes" is meaningless on its own — it
  // means "I understood, move to my results" after the risk explanation,
  // but "give me the doctor questions" after the pathway module's offer.
  if (pendingConfirmation === "understanding") {
    if (AFFIRMATIVE.test(text)) {
      topics.add("confirmed_understanding");
      return [...topics];
    }
    if (NEGATIVE.test(text)) {
      topics.add("understanding");
      return [...topics];
    }
  }
  if (pendingConfirmation === "doctor_questions") {
    if (AFFIRMATIVE.test(text)) {
      topics.add("clinician_discussion");
      return [...topics];
    }
    if (NEGATIVE.test(text)) {
      // User declined; nothing further to retrieve — let scope-and-safety
      // (always included) close things out.
      return [];
    }
  }

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
  // Separate from clinician_discussion (which is about preparing a
  // question list) — this triggers the pathway module's actual general
  // screening guideline content (e.g., the USPSTF biennial mammography
  // guidance for the average-risk branch), not question-prep content.
  if (containsAny(text, ["screen", "screening", "mammogram", "mammography", "biennial", "how often should i", "what screening", "treatment"])) {
    topics.add("screening_guidance");
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
  // Set this to whichever confirmation question the assistant's previous
  // turn ended with, so a bare "yes"/"no" reply resolves correctly. Leave
  // undefined on turns that didn't end with a yes/no question.
  pendingConfirmation?: PendingConfirmation;
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
  const topics = input.topics?.length
    ? input.topics
    : inferTopics(input.userMessage, input.pendingConfirmation);

  const selected = MODULES.filter((module) => {
    if (module.alwaysInclude) return true;
    if (!module.stages.includes(stage)) return false;
    if (!module.branches.includes(branch)) return false;

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
