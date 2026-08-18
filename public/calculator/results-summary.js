const result = JSON.parse(sessionStorage.getItem("breastRiskResult") || "null");
const session = JSON.parse(sessionStorage.getItem("breastRiskSession") || "null");
const riskResults = document.getElementById("riskResults");
const missingResult = document.getElementById("missingResult");
const printRiskButton = document.getElementById("printRiskButton");

function formatPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(2)}%` : "—";
}

function labelFor(value, labels) {
  return labels[String(value)] ?? "Unknown";
}

function renderAnswerSummary(inputs) {
  const summary = document.getElementById("answerSummary");
  const list = document.getElementById("answerSummaryList");
  if (!summary || !list || !inputs || !Object.keys(inputs).length) return;

  const yesNoUnknown = { yes: "Yes", no: "No", unknown: "Unknown" };
  const rows = [
    ["Age", inputs.currentAge],
    ["Race or ethnicity", inputs.raceGroupLabel || "Unknown"],
  ];

  if (inputs.raceSubgroupLabel) rows.push(["Sub-race, ethnicity, or birthplace", inputs.raceSubgroupLabel]);
  rows.push(["Previous benign breast biopsy", labelFor(inputs.benignBiopsy, yesNoUnknown)]);
  if (inputs.benignBiopsy === "yes") {
    rows.push(
      ["Number of benign breast biopsies", labelFor(inputs.biopsyCount, { 1: "1", 2: "2 or more" })],
      ["Atypical hyperplasia", labelFor(inputs.hyperplasia, { 0: "No", 1: "Yes", 99: "Unknown" })],
    );
  }
  rows.push(
    ["Age at first menstrual period", labelFor(inputs.ageMen, { 11: "7 to 11", 12: "12 to 13", 14: "14 or older", 99: "Unknown" })],
    ["Age at first live birth", labelFor(inputs.ageFirstBirth, { 19: "Younger than 20", 22: "20 to 24", 27: "25 to 29", 30: "30 or older", 98: "No live births", 99: "Unknown" })],
    ["First-degree relatives with breast cancer", labelFor(inputs.relatives, { 0: "None", 1: "One", 2: "More than one", 99: "Unknown" })],
  );

  list.replaceChildren(...rows.map(([term, value]) => {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = String(value ?? "Unknown");
    row.append(dt, dd);
    return row;
  }));
  summary.classList.remove("hidden");
}

if (!result) {
  riskResults.classList.add("hidden");
  missingResult.classList.remove("hidden");
} else {
  document.getElementById("fiveYearIndividual").textContent = formatPercent(result.fiveYearRisk?.individualPercent);
  document.getElementById("fiveYearAverage").textContent = formatPercent(result.fiveYearRisk?.averagePercent);
  document.getElementById("fiveYearDetails").textContent =
    `Estimated from age ${result.fiveYearRisk.startAge} through age ${result.fiveYearRisk.endAge}.
    The patient's estimated lifetime risk is ${result.fiveYearRisk.individualPercent}%, compared with ${result.fiveYearRisk.averagePercent}% for women of the same age and race/ethnicity in the general U.S. population.`;
    
  document.getElementById("lifetimeIndividual").textContent = formatPercent(result.lifetimeRisk?.individualPercent);
  document.getElementById("lifetimeAverage").textContent = formatPercent(result.lifetimeRisk?.averagePercent);
  document.getElementById("lifetimeDetails").textContent =
    `Estimated from age ${result.lifetimeRisk.startAge} through age ${result.lifetimeRisk.endAge}.
    The patient's estimated lifetime risk is ${result.lifetimeRisk.individualPercent}%, compared with ${result.lifetimeRisk.averagePercent}% for women of the same age and race/ethnicity in the general U.S. population.`;
  renderAnswerSummary(session?.questionnaireInputs);
}

printRiskButton?.addEventListener("click", () => window.print());

if (result && new URLSearchParams(window.location.search).get("print") === "1") {
  window.setTimeout(() => window.print(), 300);
}
