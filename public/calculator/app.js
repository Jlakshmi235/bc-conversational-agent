const API_URL = "/api/calculate-risk";

const form = document.getElementById("riskForm");
const submitButton = document.getElementById("submitButton");
const errorBox = document.getElementById("error");
const eligibilityMessage = document.getElementById("eligibilityMessage");
const riskAcknowledgment = document.getElementById("riskAcknowledgment");

const raceGroup = document.getElementById("raceGroup");
const subgroupWrapper = document.getElementById("subgroupWrapper");
const raceSubgroup = document.getElementById("raceSubgroup");
const biopsyDetails = document.getElementById("biopsyDetails");
const demographicsSection = document.getElementById("demographicsSection");
const familyHistorySection = document.getElementById("familyHistorySection");

const modal = document.getElementById("warningModal");
const modalContent = modal.querySelector(".modal-content");
const warningMessage = document.getElementById("warningMessage");
const closeModalButton = document.getElementById("closeWarningModal");

const riskResults = document.getElementById("riskResults");
const resultModel = document.getElementById("resultModel");
const fiveYearIndividual = document.getElementById("fiveYearIndividual");
const fiveYearAverage = document.getElementById("fiveYearAverage");
const fiveYearDetails = document.getElementById("fiveYearDetails");
const lifetimeIndividual = document.getElementById("lifetimeIndividual");
const lifetimeAverage = document.getElementById("lifetimeAverage");
const lifetimeDetails = document.getElementById("lifetimeDetails");

let lastFocusedElement = null;


const SESSION_KEY = "breastRiskSession";
const QUESTIONNAIRE_STARTED_AT = new Date().toISOString();

function createSessionId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY)) || null;
  } catch {
    return null;
  }
}

function writeSession(session) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function ensureSession() {
  const existing = readSession();
  if (existing && !existing.timestamps?.riskCalculatedAt) return existing;

  // A completed assessment is a finished app session. Starting the calculator
  // again must not carry its result, avatar connection, or text conversation
  // into the next assessment, even though sessionStorage survives in this tab.
  if (existing) {
    sessionStorage.removeItem("breastRiskResult");
    sessionStorage.removeItem("liveAvatarSession");
    sessionStorage.removeItem("breastRiskTextTranscript");
  }

  const session = {
    schemaVersion: "1.0",
    sessionId: createSessionId(),
    createdAt: QUESTIONNAIRE_STARTED_AT,
    timestamps: {
      questionnaireStartedAt: QUESTIONNAIRE_STARTED_AT,
      riskCalculatedAt: null,
      resultsPageOpenedAt: null,
      conversationStartedAt: null,
      conversationEndedAt: null,
      lastUpdatedAt: QUESTIONNAIRE_STARTED_AT
    },
    durationsMs: {
      questionnaire: null,
      resultsPage: null,
      conversation: null,
      totalTimeOnTask: null
    },
    context: {
      language: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      userAgent: navigator.userAgent
    },
    questionnaireInputs: {},
    riskResults: null,
    riskBranch: null,
    avatar: {
      selectedKey: null,
      selectedName: null,
      liveStatus: "not_started"
    },
    guidedTopicsSelected: [],
    transcript: [],
    events: []
  };

  writeSession(session);
  return session;
}

let sessionLog = ensureSession();

function elapsedFromSessionStart(timestamp = Date.now()) {
  const start = Date.parse(sessionLog.timestamps.questionnaireStartedAt);
  return Number.isFinite(start) ? Math.max(0, timestamp - start) : null;
}

function logEvent(type, details = {}) {
  const now = Date.now();
  sessionLog.events.push({
    eventIndex: sessionLog.events.length + 1,
    timestamp: new Date(now).toISOString(),
    elapsedMs: elapsedFromSessionStart(now),
    type,
    ...details
  });
  sessionLog.timestamps.lastUpdatedAt = new Date(now).toISOString();
  writeSession(sessionLog);
}

function selectedOptionText(selectElement) {
  return selectElement?.selectedOptions?.[0]?.textContent?.trim() || null;
}

logEvent("questionnaire_page_opened");


function firstValue(value, fallback = undefined) {
  if (Array.isArray(value)) return value.length ? value[0] : fallback;
  return value ?? fallback;
}

function toFiniteNumber(value, fallback = undefined) {
  const number = Number(firstValue(value, fallback));
  return Number.isFinite(number) ? number : NaN;
}

function normalizeRiskResponse(result, currentAge) {
  return {
    success: Boolean(firstValue(result.success, false)),
    model: String(firstValue(result.model, "NCI BCRAT / Gail model")),
    fiveYearRisk: {
      individualPercent: toFiniteNumber(
        result.fiveYearRisk?.individualPercent ?? result.fiveYearRisk?.percent
      ),
      averagePercent: toFiniteNumber(result.fiveYearRisk?.averagePercent),
      startAge: toFiniteNumber(result.fiveYearRisk?.startAge, currentAge),
      endAge: toFiniteNumber(result.fiveYearRisk?.endAge, currentAge + 5)
    },
    lifetimeRisk: {
      individualPercent: toFiniteNumber(
        result.lifetimeRisk?.individualPercent ?? result.lifetimeRisk?.percent
      ),
      averagePercent: toFiniteNumber(result.lifetimeRisk?.averagePercent),
      startAge: toFiniteNumber(result.lifetimeRisk?.startAge, currentAge),
      endAge: toFiniteNumber(result.lifetimeRisk?.endAge, 90)
    },
    calculatedAt: new Date().toISOString()
  };
}

function formatPercent(value) {
  return `${value.toFixed(2)}%`;
}

function displayRiskResults(result) {
  resultModel.textContent = `Risk model: ${result.model}`;

  fiveYearIndividual.textContent = formatPercent(result.fiveYearRisk.individualPercent);
  fiveYearAverage.textContent = formatPercent(result.fiveYearRisk.averagePercent);
  fiveYearDetails.textContent =
    `Estimated risk from age ${result.fiveYearRisk.startAge} to ${result.fiveYearRisk.endAge}.`;

  lifetimeIndividual.textContent = formatPercent(result.lifetimeRisk.individualPercent);
  lifetimeAverage.textContent = formatPercent(result.lifetimeRisk.averagePercent);
  lifetimeDetails.textContent =
    `Estimated risk from age ${result.lifetimeRisk.startAge} to ${result.lifetimeRisk.endAge}.`;

  riskResults.classList.remove("hidden");
  riskResults.scrollIntoView({ behavior: "smooth", block: "start" });
}

const subgroupOptions = {
  hispanic: [
    ["3", "Born in the US"],
    ["5", "Born outside the US"]
  ],
  asian: [
    ["6", "Chinese"],
    ["8", "Filipino"],
    ["9", "Hawaiian"],
    ["10", "Pacific Islander"],
    ["7", "Japanese"],
    ["11", "Other Asian"]
  ]
};

const warningMessages = {
  priorCancer:
    "This tool cannot accurately calculate breast cancer risk for women with a medical history of breast cancer, DCIS, or LCIS.",
  geneticMutation:
    "Other tools may be more appropriate for women with a known BRCA1 or BRCA2 mutation or another hereditary syndrome associated with higher breast cancer risk."
};

window.addEventListener("load", () => {
  logEvent("questionnaire_initialized");
  form.reset();
  biopsyDetails.classList.add("hidden");
  subgroupWrapper.classList.add("hidden");
  eligibilityMessage.classList.add("hidden");
  errorBox.classList.add("hidden");

  form.querySelectorAll("input, select, button").forEach((element) => {
    element.disabled = false;
  });
});

raceGroup.addEventListener("change", () => {
  logEvent("input_changed", { inputName: "raceGroup", inputValue: raceGroup.value });
  raceSubgroup.innerHTML = '<option value="">Choose one</option>';
  const options = subgroupOptions[raceGroup.value];

  if (options) {
    for (const [value, label] of options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      raceSubgroup.appendChild(option);
    }
    subgroupWrapper.classList.remove("hidden");
    raceSubgroup.required = true;
  } else {
    subgroupWrapper.classList.add("hidden");
    raceSubgroup.required = false;
    raceSubgroup.value = "";
  }
});

form.addEventListener("change", (event) => {
  if (event.target.name === "benignBiopsy") {
    logEvent("input_changed", { inputName: "benignBiopsy", inputValue: event.target.value });
    const hasBiopsy = event.target.value === "yes";
    biopsyDetails.classList.toggle("hidden", !hasBiopsy);

    for (const input of biopsyDetails.querySelectorAll(
      'input:not([type="hidden"])'
    )) {
      input.required = hasBiopsy;
      if (!hasBiopsy) input.checked = false;
    }
  }
});

function getRadioValue(name) {
  return form.querySelector(`input[name="${name}"]:checked`)?.value ?? "";
}

function mapRaceCode() {
  if (raceSubgroup.value) return Number(raceSubgroup.value);

  const directCodes = {
    white: 1,
    black: 2,
    "native-other": 4,
    unknown: 4
  };

  return directCodes[raceGroup.value];
}

function clearMessages() {
  errorBox.classList.add("hidden");
  eligibilityMessage.classList.add("hidden");
}

function validationContainer(input) {
  if (input.type === "radio") return input.closest(".question");
  if (input.type === "checkbox") return input.closest(".acknowledgment");
  return input.closest("#subgroupWrapper") || input;
}

function clearValidation(input) {
  const container = validationContainer(input);
  container?.classList.remove("has-validation-error");
  input.removeAttribute("aria-invalid");
  const message = container?.matches("input, select")
    ? container.nextElementSibling?.classList.contains("validation-message") && container.nextElementSibling
    : container?.querySelector(":scope > .validation-message");
  if (message) message.remove();
}

function showValidation(input, message) {
  const container = validationContainer(input);
  if (!container) return;

  clearValidation(input);
  container.classList.add("has-validation-error");
  input.setAttribute("aria-invalid", "true");

  if (message) {
    const validationMessage = document.createElement("p");
    validationMessage.className = "validation-message";
    validationMessage.setAttribute("role", "alert");
    validationMessage.textContent = message;
    if (container.matches("input, select")) {
      container.insertAdjacentElement("afterend", validationMessage);
    } else {
      container.appendChild(validationMessage);
    }
  }
}

function validateForm() {
  const errors = [];
  const handledRadioGroups = new Set();

  form.querySelectorAll("[required]").forEach((input) => {
    if (input.disabled || input.closest(".hidden")) return;

    if (input.type === "radio") {
      if (handledRadioGroups.has(input.name)) return;
      handledRadioGroups.add(input.name);
      const group = [...form.querySelectorAll(`input[type="radio"][name="${input.name}"]`)]
        .filter((radio) => !radio.disabled && !radio.closest(".hidden"));
      group.forEach(clearValidation);
      if (!group.some((radio) => radio.checked)) {
        errors.push({ input: group[0], message: "" });
      }
      return;
    }

    clearValidation(input);
    if (input.type === "checkbox" && !input.checked) {
      errors.push({ input, message: "" });
    } else if (!input.value.trim()) {
      errors.push({ input, message: "" });
    }
  });

  const ageInput = document.getElementById("currentAge");
  const age = Number(ageInput.value);
  if (ageInput.value && (!Number.isFinite(age) || age < 35 || age > 85)) {
    const existingAgeError = errors.findIndex(({ input }) => input === ageInput);
    if (existingAgeError !== -1) errors.splice(existingAgeError, 1);
    errors.push({
      input: ageInput,
      message: "This tool is only suitable for women ages 35–85.",
    });
  }

  errors.forEach(({ input, message }) => showValidation(input, message));
  if (!errors.length) return true;

  const first = errors[0].input;
  validationContainer(first)?.scrollIntoView({ behavior: "smooth", block: "center" });
  window.setTimeout(() => first.focus({ preventScroll: true }), 350);
  return false;
}

form.addEventListener("input", (event) => clearValidation(event.target));
form.addEventListener("change", (event) => clearValidation(event.target));

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove("hidden");
  errorBox.scrollIntoView({ behavior: "smooth", block: "center" });
}

function showEligibilityMessage(message) {
  eligibilityMessage.textContent = message;
  eligibilityMessage.classList.remove("hidden");
}

function openWarningModal(message) {
  lastFocusedElement = document.activeElement;
  warningMessage.textContent = message;
  modal.classList.remove("hidden");
  document.body.classList.add("modal-open");
  modalContent.focus();
}

function closeWarningModal() {
  modal.classList.add("hidden");
  document.body.classList.remove("modal-open");
  lastFocusedElement?.focus();
}

function setSurveyDisabled(disabled) {
  demographicsSection.disabled = disabled;
  familyHistorySection.disabled = disabled;
  riskAcknowledgment.disabled = disabled;
  submitButton.disabled = disabled;
}

function checkEligibility() {
  const priorCancer = getRadioValue("priorCancerOrChestRadiation");
  const geneticMutation = getRadioValue("geneticMutation");
  const geneticInputs = form.querySelectorAll(
    'input[name="geneticMutation"]'
  );

  let message = "";

  if (priorCancer === "yes") {
    message = warningMessages.priorCancer;
    geneticInputs.forEach((input) => {
      input.disabled = true;
    });
  } else {
    geneticInputs.forEach((input) => {
      input.disabled = false;
    });

    if (geneticMutation === "yes") {
      message = warningMessages.geneticMutation;
    }
  }

  const isLocked = Boolean(message);
  setSurveyDisabled(isLocked);
  clearMessages();

  if (isLocked) {
    logEvent("eligibility_blocked", { reason: message });
    showEligibilityMessage(message);
    openWarningModal(message);
  } else {
    closeWarningModal();
  }
}

document
  .querySelectorAll(
    'input[name="priorCancerOrChestRadiation"], input[name="geneticMutation"]'
  )
  .forEach((radio) => radio.addEventListener("change", checkEligibility));

closeModalButton.addEventListener("click", closeWarningModal);

modal.addEventListener("click", (event) => {
  if (event.target.classList.contains("modal-backdrop")) closeWarningModal();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !modal.classList.contains("hidden")) {
    closeWarningModal();
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessages();

  if (!validateForm()) return;

  if (getRadioValue("priorCancerOrChestRadiation") === "yes") {
    showEligibilityMessage(warningMessages.priorCancer);
    return;
  }

  if (getRadioValue("geneticMutation") === "yes") {
    showEligibilityMessage(warningMessages.geneticMutation);
    return;
  }

  const currentAge = Number(document.getElementById("currentAge").value);
  const benignBiopsy = getRadioValue("benignBiopsy");

  const payload = {
    currentAge,
    projectionAge: currentAge + 5,
    ageMen: Number(getRadioValue("ageMen")),
    ageFirstBirth: Number(
      document.getElementById("ageFirstBirth").value
    ),
    biopsies:
      benignBiopsy === "yes"
        ? Number(getRadioValue("biopsyCount"))
        : benignBiopsy === "unknown"
          ? 99
          : 0,
    hyperplasia:
      benignBiopsy === "yes"
        ? Number(getRadioValue("hyperplasia"))
        : 99,
    relatives: Number(getRadioValue("relatives")),
    race: mapRaceCode()
  };

  if (!Number.isFinite(payload.race)) {
    showError("Choose a valid race or ethnicity subgroup.");
    return;
  }

  sessionLog.questionnaireInputs = {
    priorCancerOrChestRadiation: getRadioValue("priorCancerOrChestRadiation"),
    geneticMutation: getRadioValue("geneticMutation"),
    currentAge,
    raceGroup: raceGroup.value,
    raceGroupLabel: selectedOptionText(raceGroup),
    raceSubgroup: raceSubgroup.value || null,
    raceSubgroupLabel: raceSubgroup.value ? selectedOptionText(raceSubgroup) : null,
    benignBiopsy,
    biopsyCount: payload.biopsies,
    hyperplasia: payload.hyperplasia,
    ageMen: payload.ageMen,
    ageFirstBirth: payload.ageFirstBirth,
    relatives: payload.relatives,
    riskAcknowledgment: riskAcknowledgment.checked,
    apiPayload: payload
  };
  writeSession(sessionLog);
  logEvent("risk_calculation_started", {
    inputCount: Object.keys(sessionLog.questionnaireInputs).length
  });

  submitButton.disabled = true;
  submitButton.textContent = "Calculating...";

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        result.detail || result.error || "Risk calculation failed."
      );
    }

    const normalized = normalizeRiskResponse(result, currentAge);

    if (!normalized.success) {
      throw new Error(result.detail || result.error || "Risk calculation was not successful.");
    }

    const values = [
      normalized.fiveYearRisk.individualPercent,
      normalized.fiveYearRisk.averagePercent,
      normalized.lifetimeRisk.individualPercent,
      normalized.lifetimeRisk.averagePercent
    ];

    if (!values.every(Number.isFinite)) {
      throw new Error(
        "The API must return individualPercent and averagePercent " +
          "for both time horizons."
      );
    }

    sessionStorage.setItem(
      "breastRiskResult",
      JSON.stringify(normalized)
    );

    const calculatedAt = new Date();
    sessionLog.riskResults = normalized;
    sessionLog.riskBranch =
      normalized.lifetimeRisk.individualPercent < 20 &&
      normalized.fiveYearRisk.individualPercent < 1.7
        ? "standard"
        : "follow_up";
    sessionLog.timestamps.riskCalculatedAt = calculatedAt.toISOString();
    sessionLog.durationsMs.questionnaire =
      calculatedAt.getTime() -
      Date.parse(sessionLog.timestamps.questionnaireStartedAt);
    writeSession(sessionLog);
    logEvent("risk_calculation_succeeded", {
      riskBranch: sessionLog.riskBranch,
      fiveYearIndividualPercent:
        normalized.fiveYearRisk.individualPercent,
      fiveYearAveragePercent:
        normalized.fiveYearRisk.averagePercent,
      lifetimeIndividualPercent:
        normalized.lifetimeRisk.individualPercent,
      lifetimeAveragePercent:
        normalized.lifetimeRisk.averagePercent
    });

    window.location.href = "results.html";
  } catch (error) {
    logEvent("risk_calculation_failed", { error: error.message });
    showError(error.message);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Calculate risk";
  }
});
