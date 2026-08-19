import systemPromptRaw from "../../prompts/system-prompt.md?raw";
import scopeSafetyRaw from "../../knowledge/modules/00_scope-and-safety.md?raw";
import explainRiskRaw from "../../knowledge/modules/01_explain-risk.md?raw";
import understandingRaw from "../../knowledge/modules/02_understanding-and-concerns.md?raw";
import lowAverageRaw from "../../knowledge/modules/03_low-average-risk-pathway.md?raw";
import elevatedRaw from "../../knowledge/modules/04_elevated-risk-pathway.md?raw";
import limitationsRaw from "../../knowledge/modules/05_gail-limitations.md?raw";
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
//
// NOTE: "model_factors" is retained for backward compatibility but should
// no longer fire under the current content design — 05_gail-limitations.md
// and 02_understanding-and-concerns.md were revised to explain calculator
// factors directly, without first asking "would you like to hear what it
// includes, excludes, or both?" (that compound-offer pattern was removed
// after it produced a confusing double question). inferPendingConfirmation
// below will effectively never return "model_factors" against current
// module content. Safe to remove this branch entirely in a future cleanup
// once you've confirmed nothing still asks that offer question.
export type PendingConfirmation = "understanding" | "doctor_questions" | "model_factors";

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

// Keep the source modules detailed for clinical/content review, but omit
// repeated theory, style, and citation sections from the prompt sent on every
// turn. The system prompt and always-loaded scope addendum enforce those rules.
const RUNTIME_OMITTED_SECTIONS = new Set([
  "theory tags",
  "theory use",
  "ftt use",
  "ftt communication behavior",
  "ftt boundary",
  "pmt use",
  "pmt communication behavior",
  "tone guidance",
  "spoken delivery format",
  "sources",
  "disclaimer",
  "safety",
  "scope",
]);

function compactModuleForRuntime(markdown: string): string {
  const lines = stripFrontMatter(markdown).split("\n");
  let omitSection = false;
  const kept = lines.filter((line) => {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      omitSection = RUNTIME_OMITTED_SECTIONS.has(heading[1].toLowerCase());
      return !omitSection;
    }
    return !omitSection;
  });
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const MODULES: KnowledgeModule[] = [
  {
    id: "scope-and-safety",
    alwaysInclude: true,
    stages: ["initial_explanation", "follow_up", "closing"],
    branches: ["low-average", "elevated"],
    topics: [],
    content: compactModuleForRuntime(scopeSafetyRaw),
  },
  {
    id: "explain-risk",
    alwaysInclude: false,
    stages: ["initial_explanation"],
    branches: ["low-average", "elevated"],
    topics: ["risk_explanation"],
    content: compactModuleForRuntime(explainRiskRaw),
  },
  {
    id: "understanding-and-concerns",
    alwaysInclude: false,
    stages: ["follow_up"],
    branches: ["low-average", "elevated"],
    topics: ["understanding", "concerns", "risk_explanation"],
    content: compactModuleForRuntime(understandingRaw),
  },
  {
    id: "gail-limitations",
    alwaysInclude: false,
    stages: ["follow_up"],
    branches: ["low-average", "elevated"],
    topics: ["model_limitations", "risk_factors", "family_history"],
    content: compactModuleForRuntime(limitationsRaw),
  },
  {
    id: "low-average-risk-pathway",
    alwaysInclude: false,
    stages: ["follow_up", "closing"],
    branches: ["low-average"],
    topics: ["confirmed_understanding", "screening_guidance"],
    content: compactModuleForRuntime(lowAverageRaw),
  },
  {
    id: "elevated-risk-pathway",
    alwaysInclude: false,
    stages: ["follow_up", "closing"],
    branches: ["elevated"],
    topics: ["confirmed_understanding", "screening_guidance"],
    content: compactModuleForRuntime(elevatedRaw),
  },
  {
    id: "clinical-discussion",
    alwaysInclude: false,
    stages: ["follow_up", "closing"],
    branches: ["low-average", "elevated"],
    topics: ["clinician_discussion", "next_steps", "family_history"],
    content: compactModuleForRuntime(clinicianDiscussionRaw),
  },
];

function containsAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

// Whole-message match only — deliberately not a substring check, so a
// longer message that happens to contain "yes" somewhere isn't swept into
// this branch. Bare confirmations are short by nature.
const AFFIRMATIVE = /^(yes|yeah|yep|yup|sure|ok|okay|got it|that makes sense|makes sense|understood|i understand|i think so|that helps|sounds good)[.,!]?$/;
const NEGATIVE = /^(no(?:,?\s+(?:that'?s fine|thanks?|thank you))?|nah|not really|not quite|not really understand|i don'?t|no thanks|not right now)[.,!]?$/;

export function inferPendingConfirmation(
  assistantMessage = ""
): PendingConfirmation | undefined {
  const text = assistantMessage.toLowerCase().replace(/[’]/g, "'");
  if (!text.trim()) return undefined;

  // Broadened beyond a single literal phrase — the assistant's actual
  // wording varies ("does that make sense", "does that help", "did that
  // answer your question", etc.), so this checks for the question shape
  // rather than one exact string.
  if (containsAny(text, [
    "does that make sense",
    "did that make sense",
    "does this make sense",
    "did that answer your question",
    "is that clear",
    "does that help",
    "does that clarify",
    "make sense so far",
  ])) {
    return "understanding";
  }
  // Broadened to match the actual offer wording used in the pathway
  // modules ("a few questions you could bring to your next doctor visit" /
  // "a few questions you could bring to that visit") — the original
  // keyword list ("questions to bring") didn't match either phrasing and
  // would have silently failed to set this state.
  if (containsAny(text, [
    "questions you could bring",
    "questions to bring",
    "questions for your doctor",
    "questions for your clinician",
    "prepare questions",
    "bring to your next doctor visit",
    "bring to that visit",
    "bring to your visit",
  ])) {
    return "doctor_questions";
  }
  // Broadened again — a real transcript showed the assistant offering
  // "would you like me to explain how the risk calculator works?" which
  // didn't match any of the phrases below, so the follow-up "yes" fell
  // through to generic keyword matching instead of routing to the
  // calculator-factors content. This is exactly the case this branch
  // exists for, so it needs to actually catch the assistant's natural
  // phrasing, not just the narrower original wording.
  if (containsAny(text, [
    "what the gail calculator looks at",
    "what the calculator looks at",
    "factors it does include",
    "ones it doesn't fully capture",
    "one of those factors",
    "explain how the risk calculator works",
    "explain how it works",
    "how the calculator works",
    "how the risk calculator works",
    "how this is calculated",
    "how it's calculated",
    "tell you about the calculator",
    "tell you more about the calculator",
  ])) {
    return "model_factors";
  }
  return undefined;
}

export function inferTopics(
  userMessage = "",
  pendingConfirmation?: PendingConfirmation
): KnowledgeTopic[] {
  const text = userMessage.toLowerCase().trim().replace(/[’]/g, "'");
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
      // The understanding module directs a confused user straight into a
      // brief explanation of what the calculator considers. Retrieve that
      // content on the same turn instead of asking another question.
      topics.add("risk_factors");
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
  if (pendingConfirmation === "model_factors") {
    if (AFFIRMATIVE.test(text)) {
      topics.add("model_limitations");
      topics.add("risk_factors");
      return [...topics];
    }
    if (NEGATIVE.test(text)) return [];
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
  // Added "calculator", "how does it work", "how is it calculated", "what
  // goes into" — these are the natural, expected phrasings now that the
  // assistant itself always calls the tool "the risk calculator." The
  // original list only had the pre-rename terms ("model", "gail",
  // "bcrat"), which a user has no particular reason to say back, since
  // they only ever hear "the risk calculator" from the assistant.
  if (containsAny(text, ["limitation", "accurate", "accuracy", "leave out", "include", "model", "gail", "bcrat", "calculator", "how does it work", "how it works", "how is it calculated", "how is this calculated", "what goes into", "how was this calculated"])) {
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
  const fiveYearRisk = Number(f?.individualPercent);
  const fiveYearAverage = Number(f?.averagePercent);
  const lifetimeRisk = Number(l?.individualPercent);
  const lifetimeAverage = Number(l?.averagePercent);
  const comparisonDirection = (individual: number, average: number) => {
    if (!Number.isFinite(individual) || !Number.isFinite(average)) return "unknown";
    if (individual < average) return "below";
    if (individual > average) return "above";
    return "equal to";
  };
  // Precomputed natural-frequency values for the 5-year figure only, per
  // 01_explain-risk.md's natural-frequency framing rule. Computed here
  // rather than left to the model for the same reason comparisonDirection
  // and thresholdReasons are: percent-to-frequency conversion and
  // rounding is exactly the kind of arithmetic an LLM can get wrong in a
  // live spoken turn, and there's no reason to risk it when the app
  // already has the raw numbers. Uses "out of 1,000," not "out of 100" —
  // 5-year figures are usually small (often under 5%), and 100 as a
  // denominator frequently rounds two different percentages to the same
  // whole number (e.g., 1.9% and 2.2% both round to "2 out of 100"),
  // erasing the exact comparison the gist depends on. Both the individual
  // and average values use the same denominator and rounding method, per
  // Paling's consistent-denominator principle, so the comparison stays
  // meaningful. Deliberately NOT computed for the lifetime figure —
  // lifetime percentages are usually large enough to be intuitive without
  // conversion, and 01_explain-risk.md explicitly scopes this to 5-year
  // only to keep the turn from running long.
  const toPerThousand = (percent: number): number | null => {
    if (!Number.isFinite(percent)) return null;
    return Math.round((percent / 100) * 1000);
  };
  const fiveYearIndividualPerThousand = toPerThousand(fiveYearRisk);
  const fiveYearAveragePerThousand = toPerThousand(fiveYearAverage);
  const fiveYearFrequenciesEqual =
    fiveYearIndividualPerThousand !== null &&
    fiveYearAveragePerThousand !== null &&
    fiveYearIndividualPerThousand === fiveYearAveragePerThousand;
  const fiveYearMeets = fiveYearRisk >= 1.67;
  const lifetimeMeets = lifetimeRisk >= 20;
  const thresholdReasons = [
    fiveYearMeets ? "5-year risk meets the 1.67% cutoff (about 1.7%)" : "",
    lifetimeMeets ? "lifetime risk meets the 20% cutoff" : "",
  ].filter(Boolean);
  // A mismatch is only when a comparison direction is "below" (or "equal
  // to") while the branch is elevated, or "above" while the branch is
  // low-average — i.e., the plain-language gist and the fixed-cutoff
  // label would otherwise sound contradictory. Most elevated results do
  // NOT have a mismatch (the individual number is usually above the
  // comparison average too) — the specific cutoff percentage should only
  // ever be spoken in the mismatch case, never as routine narration of
  // why something is elevated.
  const fiveYearMismatch = branch === "elevated"
    ? comparisonDirection(fiveYearRisk, fiveYearAverage) !== "above"
    : comparisonDirection(fiveYearRisk, fiveYearAverage) === "above" && fiveYearMeets;
  const lifetimeMismatch = branch === "elevated"
    ? comparisonDirection(lifetimeRisk, lifetimeAverage) !== "above"
    : comparisonDirection(lifetimeRisk, lifetimeAverage) === "above" && lifetimeMeets;
  const hasMismatch = (fiveYearMeets && fiveYearMismatch) || (lifetimeMeets && lifetimeMismatch);
  return [
    "# Application-supplied patient risk context",
    `Risk branch selected by the application: ${branch}`,
    `Model: ${risk.model ?? "NCI BCRAT / Gail model"}`,
    `5-year individual risk: ${f?.individualPercent ?? "unknown"}%`,
    `5-year population comparison: ${f?.averagePercent ?? "unknown"}%`,
    `5-year comparison direction: ${comparisonDirection(fiveYearRisk, fiveYearAverage)}`,
    `5-year individual risk (natural frequency, precomputed): ${fiveYearIndividualPerThousand ?? "unknown"} out of 1,000`,
    `5-year population comparison (natural frequency, precomputed): ${fiveYearAveragePerThousand ?? "unknown"} out of 1,000`,
    `5-year age range: ${f?.startAge ?? "unknown"}-${f?.endAge ?? "unknown"}`,
    `Lifetime individual risk: ${l?.individualPercent ?? "unknown"}%`,
    `Lifetime population comparison: ${l?.averagePercent ?? "unknown"}%`,
    `Lifetime comparison direction: ${comparisonDirection(lifetimeRisk, lifetimeAverage)}`,
    `Lifetime age range: ${l?.startAge ?? "unknown"}-${l?.endAge ?? "unknown"}`,
    `Application classification basis (internal use only — see instruction below): ${thresholdReasons.length ? thresholdReasons.join(" and ") : "neither fixed cutoff is met"}`,
    `Does this result need reconciliation language: ${hasMismatch ? "YES — comparison direction and label disagree" : "NO — comparison direction and label already agree"}`,
    "IMPORTANT: the 'classification basis' line above and the specific cutoff percentages (1.67%, 20%) are for your own grounding only. Do NOT speak the specific cutoff number to the user unless the 'reconciliation' line above says YES. If it says NO, simply state the classification plainly (e.g., 'based on these results, the calculator places this in the elevated-risk category') without mentioning 1.67%, 1.7%, or 20% at all — citing the internal cutoff in the normal, non-contradictory case is incorrect and should not happen.",
    `IMPORTANT: when stating the 5-year natural-frequency framing per 01_explain-risk.md, use the precomputed "out of 1,000" values above exactly as given — do not calculate this conversion yourself, and do not reduce it to a "1 in X" ratio. Do not apply this conversion to the lifetime figure. ${fiveYearFrequenciesEqual ? "Note: the individual and average values round to the same whole number at this scale — state both counts as given rather than forcing an artificial distinction." : ""}`,
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
    ...(topics.length === 0 && input.pendingConfirmation
      ? [
          "# Conversation state",
          "The user declined the assistant's previous offer. Acknowledge that choice briefly and close the current topic. Do not restart the conversation, repeat the risk explanation, or ask the declined question again.",
        ]
      : []),
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
