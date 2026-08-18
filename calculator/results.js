import { Room, RoomEvent, Track } from "livekit-client";

const result = JSON.parse(sessionStorage.getItem("breastRiskResult") || "null");

const riskResults = document.getElementById("riskResults");
const missingResult = document.getElementById("missingResult");
const conversationConsent = document.getElementById("conversationConsent");
const explainRiskButton = document.getElementById("explainRiskButton");
const explainRiskStatus = document.getElementById("explainRiskStatus");
const avatarConnection = document.getElementById("avatarConnection");
const avatarStatus = document.getElementById("avatarStatus");
const avatarStage = document.getElementById("avatarStage");
const avatarPlaceholderText = document.getElementById("avatarPlaceholderText");
const sessionStateBadge = document.getElementById("sessionStateBadge");
const sessionTimer = document.getElementById("sessionTimer");
const endConversationButton = document.getElementById("endConversationButton");
const reconnectButton = document.getElementById("reconnectButton");
const muteButton = document.getElementById("muteButton");
const transcriptButton = document.getElementById("transcriptButton");
const enableAudioButton = document.getElementById("enableAudioButton");
const microphoneStatus = document.getElementById("microphoneStatus");
const textConversation = document.getElementById("textConversation");
const textConversationHeading = document.getElementById("textConversationHeading");
const textTranscript = document.getElementById("textTranscript");
const textChatForm = document.getElementById("textChatForm");
const textChatInput = document.getElementById("textChatInput");
const sendTextButton = document.getElementById("sendTextButton");
const clearTranscriptButton = document.getElementById("clearTranscriptButton");
const textChatStatus = document.getElementById("textChatStatus");
const liveAvatarCredits = document.getElementById("liveAvatarCredits");
const conversationDocumentActions = document.getElementById("conversationDocumentActions");
const conversationNavigationActions = document.getElementById("conversationNavigationActions");
const printRiskButton = document.getElementById("printRiskButton");
const saveTranscriptButton = document.getElementById("saveTranscriptButton");
const downloadJsonButton = document.getElementById("downloadJsonButton");
const avatarChoices = [...document.querySelectorAll('input[name="avatarChoice"]')];
const avatarPicker = document.getElementById("avatarPicker");
const answerSummary = document.getElementById("answerSummary");
const answerSummaryList = document.getElementById("answerSummaryList");

let liveAvatarSession = null;
let sessionEndRequested = false;
let currentSession = JSON.parse(sessionStorage.getItem("liveAvatarSession") || "null");
let microphoneMuted = false;
let sessionTimerInterval = null;
let liveAvatarCreditsAvailable = null;
const receivedVoiceEventIds = new Set();
const SESSION_LOG_KEY = "breastRiskSession";
const TEXT_TRANSCRIPT_KEY = "breastRiskTextTranscript";

function readSessionLog() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_LOG_KEY) || "null");
  } catch {
    return null;
  }
}

function readTextMessages() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(TEXT_TRANSCRIPT_KEY) || "null");
    const sessionId = readSessionLog()?.sessionId;
    return stored?.sessionId === sessionId && Array.isArray(stored.messages)
      ? stored.messages
      : [];
  } catch {
    return [];
  }
}

let textMessages = readTextMessages();
const voiceDrafts = { user: null, assistant: null };

const avatarPlaceholders = {
  "avatar-1": "assets/avatar-educator-1.png",
  "avatar-2": "assets/avatar-educator-2.png",
  "avatar-3": "assets/avatar-educator-3.png",
};

function selectedAvatarKey() {
  return avatarChoices.find((choice) => choice.checked)?.value || "avatar-1";
}

function syncAvatarPlaceholder() {
  const avatarKey = selectedAvatarKey();
  const image = avatarStage.querySelector(".avatar-stage-placeholder img");
  if (!image) return;
  image.src = avatarPlaceholders[avatarKey] || avatarPlaceholders["avatar-1"];
  image.alt = `Selected AI health educator ${avatarKey.slice(-1)} placeholder`;
}

function setAvatarPickerLocked(locked) {
  avatarPicker.classList.toggle("is-locked", locked);
  avatarChoices.forEach((choice) => {
    choice.disabled = locked;
    const label = choice.closest(".avatar-picker-choice");
    if (label) label.setAttribute("aria-disabled", String(locked));
  });
}

avatarChoices.forEach((choice) => {
  choice.addEventListener("change", syncAvatarPlaceholder);
});

function writeSessionLog(session) {
  if (!session) return;
  session.timestamps = session.timestamps || {};
  session.timestamps.lastUpdatedAt = new Date().toISOString();
  sessionStorage.setItem(SESSION_LOG_KEY, JSON.stringify(session));
}

function elapsedFromSessionStart(session, timestamp = Date.now()) {
  const startedAt = Date.parse(session?.timestamps?.questionnaireStartedAt || session?.createdAt || "");
  return Number.isFinite(startedAt) ? Math.max(0, timestamp - startedAt) : null;
}

function logSessionEvent(type, details = {}) {
  const session = readSessionLog();
  if (!session) return;
  session.events = Array.isArray(session.events) ? session.events : [];
  const now = Date.now();
  session.events.push({
    eventIndex: session.events.length + 1,
    timestamp: new Date(now).toISOString(),
    elapsedMs: elapsedFromSessionStart(session, now),
    type,
    ...details,
  });
  writeSessionLog(session);
}

function updateConversationLog(patch = {}) {
  const session = readSessionLog();
  if (!session) return;
  session.timestamps = session.timestamps || {};
  session.durationsMs = session.durationsMs || {};
  session.avatar = session.avatar || {};
  session.conversation = session.conversation || {};
  Object.assign(session.conversation, patch);

  const started = Date.parse(session.timestamps.conversationStartedAt || "");
  const ended = Date.parse(session.timestamps.conversationEndedAt || "");
  if (Number.isFinite(started)) {
    session.durationsMs.conversation = Math.max(0, (Number.isFinite(ended) ? ended : Date.now()) - started);
  }
  const overallStart = Date.parse(session.timestamps.questionnaireStartedAt || session.createdAt || "");
  if (Number.isFinite(overallStart)) {
    session.durationsMs.totalTimeOnTask = Math.max(0, Date.now() - overallStart);
  }
  writeSessionLog(session);
}

function syncTextTranscriptToSessionLog() {
  const session = readSessionLog();
  if (!session) return;
  session.transcript = textMessages.map((message, index) => ({
    turnIndex: index + 1,
    channel: message.channel || "text",
    role: message.role,
    content: message.content,
    timestamp: message.timestamp || null,
    moduleIds: message.moduleIds || [],
  }));
  session.conversation = session.conversation || {};
  session.conversation.textTurnCount = session.transcript.length;
  writeSessionLog(session);
}

function renderAnswerSummary() {
  const inputs = readSessionLog()?.questionnaireInputs;
  if (!answerSummary || !answerSummaryList || !inputs || !Object.keys(inputs).length) return;

  const labelFor = (value, labels) => labels[String(value)] ?? "Unknown";
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

  answerSummaryList.replaceChildren(...rows.flatMap(([term, value]) => {
    const wrapper = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = String(value ?? "Unknown");
    wrapper.append(dt, dd);
    return wrapper;
  }));
  answerSummary.classList.remove("hidden");
}

function buildExportSnapshot() {
  const session = readSessionLog() || {};
  const now = Date.now();
  const started = Date.parse(session.timestamps?.questionnaireStartedAt || session.createdAt || "");
  const snapshot = JSON.parse(JSON.stringify(session));
  snapshot.exportedAt = new Date(now).toISOString();
  snapshot.loggingNotes = {
    storage: "Browser sessionStorage; downloaded only when the user selects an export button.",
    voiceTranscript: "Final user and avatar transcriptions emitted by the LiveAvatar Web SDK are included.",
  };
  snapshot.durationsMs = snapshot.durationsMs || {};
  if (Number.isFinite(started)) snapshot.durationsMs.totalTimeOnTask = Math.max(0, now - started);
  return snapshot;
}

function downloadBlob(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

(() => {
  const session = readSessionLog();
  if (session) {
    session.timestamps = session.timestamps || {};
    if (!session.timestamps.resultsPageOpenedAt) session.timestamps.resultsPageOpenedAt = new Date().toISOString();
    writeSessionLog(session);
    logSessionEvent("results_page_opened");
  }
})();

function formatPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(2)}%` : "—";
}

function setSessionState(label, state = "idle") {
  sessionStateBadge.textContent = label;
  sessionStateBadge.dataset.state = state;
}

function updateMuteButton() {
  const microphoneInactive = !liveAvatarSession;
  const label = microphoneInactive
    ? "Enable microphone"
    : microphoneMuted
      ? "Unmute microphone"
      : "Mute microphone";
  muteButton.classList.toggle("is-muted", microphoneMuted || microphoneInactive);
  muteButton.setAttribute("aria-label", label);
  muteButton.title = label;
}

function stopSessionTimer(finalLabel = "") {
  if (sessionTimerInterval) window.clearInterval(sessionTimerInterval);
  sessionTimerInterval = null;
  if (!sessionTimer) return;
  sessionTimer.classList.toggle("hidden", !finalLabel);
  sessionTimer.classList.remove("is-ending");
  sessionTimer.classList.toggle("is-expired", Boolean(finalLabel));
  if (finalLabel) sessionTimer.textContent = finalLabel;
}

async function stopLiveAvatarSession(room, timeoutMs = 5000, sessionId = currentSession?.sessionId) {
  let timeoutId;
  try {
    await Promise.race([
      Promise.allSettled([
        sessionId
          ? fetch("/api/liveavatar/session", {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId }),
              keepalive: true,
            })
          : Promise.resolve(),
        room ? room.disconnect() : Promise.resolve(),
      ]),
      new Promise((_, reject) => {
        timeoutId = window.setTimeout(
          () => reject(new Error("LiveAvatar session stop timed out.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

function clearStoredLiveAvatarSession() {
  const sessionId = currentSession?.sessionId || null;
  currentSession = null;
  sessionStorage.removeItem("liveAvatarSession");
  return sessionId;
}

async function handleSessionExpired(session) {
  if (currentSession?.sessionId !== session?.sessionId) return;
  flushAllVoiceDrafts();

  const expiredSessionId = currentSession.sessionId;
  const sdkSession = liveAvatarSession;
  liveAvatarSession = null;
  sessionEndRequested = true;
  clearStoredLiveAvatarSession();

  // Restore the placeholder immediately; transport cleanup can finish in the background.
  showFallback("The video session has expired. Review the transcript and continue with the text conversation below.");

  if (sdkSession) await stopLiveAvatarSession(sdkSession, 5000, expiredSessionId).catch(() => {});

  setSessionState("Expired", "ended");
  avatarStatus.textContent = "Voice session expired. You may continue by text.";
  microphoneStatus.textContent = "Microphone off.";
  muteButton.classList.add("hidden");
  enableAudioButton.classList.add("hidden");
  reconnectButton.classList.add("hidden");
  endConversationButton.classList.add("hidden");
  setAvatarPickerLocked(false);
  textConversation.classList.remove("hidden");
  explainRiskStatus.textContent = "The voice session ended. Continue with the text educator below.";
  updateConversationLog({ status: "expired", liveAvatarSessionId: expiredSessionId });
  void refreshLiveAvatarCredits();
}

function startSessionTimer(session) {
  const durationSeconds = Number(session?.maxSessionDuration);
  if (!sessionTimer || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return;

  stopSessionTimer();
  const startedAt = Date.parse(session.sessionStartedAt || "");
  const deadline = (Number.isFinite(startedAt) ? startedAt : Date.now()) + durationSeconds * 1000;

  const update = () => {
    const secondsLeft = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const minutes = Math.floor(secondsLeft / 60);
    const seconds = String(secondsLeft % 60).padStart(2, "0");
    sessionTimer.textContent = `${minutes}:${seconds} left`;
    sessionTimer.classList.remove("hidden", "is-expired");
    sessionTimer.classList.toggle("is-ending", secondsLeft > 0 && secondsLeft <= 10);

    if (secondsLeft === 0) {
      stopSessionTimer("Session expired");
      logSessionEvent("liveavatar_session_timer_expired", { sessionId: session?.sessionId || null });
      void handleSessionExpired(session);
    }
  };

  update();
  if (!sessionTimer.classList.contains("is-expired")) {
    sessionTimerInterval = window.setInterval(update, 1000);
  }
}

if (!result) {
  riskResults?.classList.add("hidden");
  missingResult.classList.remove("hidden");
  conversationConsent.disabled = true;
} else if (riskResults) {
  // document.getElementById("resultModel").textContent = result.model || "NCI BCRAT / Gail model";
  document.getElementById("fiveYearIndividual").textContent = formatPercent(result.fiveYearRisk?.individualPercent);
  document.getElementById("fiveYearAverage").textContent = formatPercent(result.fiveYearRisk?.averagePercent);
  document.getElementById("fiveYearDetails").textContent =
    `Estimated from age ${result.fiveYearRisk.startAge} through age ${result.fiveYearRisk.endAge}.\n` +
    `Based on the information provided, patient's estimated risk of developing breast cancer over the next five years is ${result.fiveYearRisk.individualPercent}%. ` +
    `For women of the same age and selected race/ethnicity in the general U.S. population, the average five-year risk is ${result.fiveYearRisk.averagePercent}%.`;

  document.getElementById("lifetimeIndividual").textContent = formatPercent(result.lifetimeRisk?.individualPercent);
  document.getElementById("lifetimeAverage").textContent = formatPercent(result.lifetimeRisk?.averagePercent);
  document.getElementById("lifetimeDetails").textContent =
    `Estimated from age ${result.lifetimeRisk.startAge} through age ${result.lifetimeRisk.endAge}.\n` +
    `Based on the information provided, patient's estimated risk of developing breast cancer through age 90 is ${result.lifetimeRisk.individualPercent}%. ` +
    `For women of the same age and selected race/ethnicity in the general U.S. population, the average lifetime risk is ${result.lifetimeRisk.averagePercent}%.`;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

async function refreshLiveAvatarCredits() {
  liveAvatarCredits.textContent = "LiveAvatar credits remaining: checking…";
  try {
    const response = await fetch("/api/liveavatar/credits", { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Credits unavailable.");
    liveAvatarCredits.textContent = `LiveAvatar credits remaining: ${payload.remainingCredits}`;
    const remainingCredits = Number(payload.remainingCredits);
    liveAvatarCreditsAvailable = Number.isFinite(remainingCredits)
      ? remainingCredits > 0
      : null;
    return liveAvatarCreditsAvailable;
  } catch (error) {
    console.error(error);
    liveAvatarCreditsAvailable = null;
    liveAvatarCredits.textContent = "LiveAvatar credits remaining: unavailable";
    return null;
  }
}

function clearAvatarMedia() {
  avatarStage.querySelectorAll("video, audio").forEach((element) => element.remove());
  transcriptButton.classList.add("hidden");
  syncAvatarPlaceholder();
}

function showFallback(message) {
  clearAvatarMedia();
  avatarStage.classList.remove("has-video");
  syncAvatarPlaceholder();
  avatarPlaceholderText.textContent = message;
  textConversation.classList.remove("hidden");
}

function finalizeEndedSessionUi({
  timerLabel = "Session ended",
  stateLabel = "Ended",
  state = "ended",
  placeholderMessage = "Video session ended. The text conversation below remains available.",
  allowReconnect = false,
} = {}) {
  clearStoredLiveAvatarSession();
  stopSessionTimer(timerLabel);
  clearAvatarMedia();
  avatarStage.classList.remove("has-video");
  avatarPlaceholderText.textContent = placeholderMessage;
  microphoneStatus.textContent = "Microphone off.";
  setSessionState(stateLabel, state);
  muteButton.classList.add("hidden");
  enableAudioButton.classList.add("hidden");
  endConversationButton.classList.add("hidden");
  endConversationButton.disabled = false;
  reconnectButton.classList.toggle("hidden", !allowReconnect);
  setAvatarPickerLocked(false);
  textConversation.classList.remove("hidden");
}

function attachLiteTrack(track) {
  if (track.kind === Track.Kind.Video) {
    avatarStage.querySelectorAll("video").forEach((element) => element.remove());
    const video = document.createElement("video");
    video.className = "avatar-video";
    video.autoplay = true;
    video.playsInline = true;
    track.attach(video);
    avatarStage.prepend(video);
    avatarStage.classList.add("has-video");
    transcriptButton.classList.remove("hidden");
    avatarStatus.textContent = "Avatar connected. You can speak naturally using your microphone.";
  } else if (track.kind === Track.Kind.Audio) {
    avatarStage.querySelectorAll("audio").forEach((element) => element.remove());
    const audio = document.createElement("audio");
    audio.autoplay = true;
    track.attach(audio);
    avatarStage.append(audio);
    audio.play().then(() => enableAudioButton.classList.add("hidden")).catch(() => {
      enableAudioButton.classList.remove("hidden");
    });
  }
}

function handleLiteData(payload, topic) {
  if (topic && topic !== "bc-risk-transcript") return;
  try {
    const message = JSON.parse(new TextDecoder().decode(payload));
    if (message?.type !== "transcript" || !["user", "assistant"].includes(message.role)) return;
    const event = {
      event_id: `${message.role}-${Date.now()}-${String(message.text).slice(0, 24)}`,
      text: String(message.text || ""),
    };
    if (message.role === "assistant") {
      textChatStatus.textContent = message.final ? "" : "The avatar is responding…";
    }
    if (message.final) appendVoiceTranscription(event, message.role);
    else appendVoiceTranscriptionChunk(event, message.role);
  } catch (error) {
    console.warn("Unable to read agent transcript data", error);
  }
}

async function connectLiveAvatarSession(sessionMetadata) {
  if (!sessionMetadata?.livekitUrl || !sessionMetadata?.livekitClientToken) {
    throw new Error("The LITE agent did not return LiveKit viewer credentials.");
  }

  if (liveAvatarSession) {
    await stopLiveAvatarSession(liveAvatarSession, 5000, currentSession?.sessionId).catch(() => {});
  }

  clearAvatarMedia();
  avatarStage.classList.remove("has-video");
  avatarConnection.classList.remove("hidden");
  setSessionState("Connecting", "connecting");
  avatarStatus.textContent = "Joining the secure LiveAvatar room…";
  sessionEndRequested = false;

  const room = new Room({ adaptiveStream: true, dynacast: true });
  let resolveVideoReady;
  const videoReady = new Promise((resolve) => { resolveVideoReady = resolve; });
  const attachSessionTrack = (track) => {
    attachLiteTrack(track);
    if (track.kind === Track.Kind.Video) resolveVideoReady();
  };
  liveAvatarSession = room;
  room
    .on(RoomEvent.TrackSubscribed, (track) => attachSessionTrack(track))
    .on(RoomEvent.TrackUnsubscribed, (track) => track.detach())
    .on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => handleLiteData(payload, topic))
    .on(RoomEvent.Disconnected, (reason) => {
      if (liveAvatarSession !== room || sessionEndRequested) return;
      sessionEndRequested = true;
      flushAllVoiceDrafts();
      const disconnectedSessionId = currentSession?.sessionId || sessionMetadata.sessionId || null;
      liveAvatarSession = null;
      finalizeEndedSessionUi({
        stateLabel: "Disconnected",
        state: "disconnected",
        placeholderMessage: "Video is unavailable. Continue with the text conversation below or try reconnecting later.",
        allowReconnect: true,
      });
      void stopLiveAvatarSession(room, 5000, disconnectedSessionId).catch(() => {});
      updateConversationLog({ status: "disconnected", liveAvatarSessionId: disconnectedSessionId });
      logSessionEvent("liveavatar_disconnected", {
        sessionId: disconnectedSessionId,
        reason: String(reason || "unknown"),
      });
      void refreshLiveAvatarCredits();
    });

  await room.connect(sessionMetadata.livekitUrl, sessionMetadata.livekitClientToken);
  if (liveAvatarSession !== room) throw new Error("The LiveAvatar room disconnected while connecting.");

  microphoneStatus.textContent = "Requesting microphone access…";
  await room.localParticipant.setMicrophoneEnabled(true, {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  });
  const microphonePublication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  if (!microphonePublication || microphonePublication.isMuted) {
    throw new Error("The microphone was allowed but no active audio track was published.");
  }
  microphoneMuted = false;

  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      if (publication.track) attachSessionTrack(publication.track);
    }
  }

  await Promise.race([
    videoReady,
    new Promise((_, reject) => window.setTimeout(
      () => reject(new Error("LiveAvatar connected but did not publish a video track within 15 seconds.")),
      15000,
    )),
  ]);

  currentSession = {
    ...sessionMetadata,
    maxSessionDuration: sessionMetadata.maxSessionDuration || 60,
    sessionStartedAt: new Date().toISOString(),
  };
  sessionStorage.setItem("liveAvatarSession", JSON.stringify(currentSession));
  startSessionTimer(currentSession);

  microphoneStatus.textContent = microphoneMuted
    ? "Microphone muted."
    : "Microphone on. Speak to the avatar when you are ready.";
  updateMuteButton();
  muteButton.classList.remove("hidden");
  setSessionState("Connected", "connected");
  reconnectButton.classList.add("hidden");
  endConversationButton.classList.remove("hidden");
  avatarStatus.textContent = "Live LITE conversation connected.";
}

function renderTranscript() {
  textTranscript.innerHTML = "";
  const activeDrafts = [voiceDrafts.user, voiceDrafts.assistant].filter(Boolean);
  if (!textMessages.length && !activeDrafts.length) {
    const empty = document.createElement("p");
    empty.className = "transcript-empty";
    empty.textContent = "No text messages yet. Ask a question below if you prefer text or if the avatar is unavailable.";
    textTranscript.appendChild(empty);
    return;
  }

  textMessages.forEach((message) => {
    const turn = document.createElement("article");
    turn.className = `conversation-turn ${message.role === "user" ? "user-turn" : "assistant-turn"}`;

    const heading = document.createElement("h4");
    heading.textContent = message.role === "user" ? "You" : "AI health educator";
    const body = document.createElement("p");
    body.textContent = message.content;

    turn.append(heading, body);
    textTranscript.appendChild(turn);
  });
  activeDrafts.forEach((message) => {
    const turn = document.createElement("article");
    turn.className = `conversation-turn ${message.role === "user" ? "user-turn" : "assistant-turn"} live-transcript-turn`;
    const heading = document.createElement("h4");
    heading.textContent = message.role === "user" ? "You" : "AI health educator";
    const body = document.createElement("p");
    body.textContent = `${message.content} …`;
    turn.append(heading, body);
    textTranscript.appendChild(turn);
  });
  textTranscript.scrollTop = textTranscript.scrollHeight;
}

function saveTranscript() {
  sessionStorage.setItem(TEXT_TRANSCRIPT_KEY, JSON.stringify({
    sessionId: readSessionLog()?.sessionId || null,
    messages: textMessages,
  }));
  renderTranscript();
}

function appendVoiceTranscription(event, role) {
  const eventId = event?.event_id;
  if (eventId && receivedVoiceEventIds.has(eventId)) return;

  const content = String(
    event?.text ?? event?.payload?.text ?? event?.data?.text ?? "",
  ).trim();
  if (!content) return;
  if (role === "user" && isLowValueUserTranscription(content)) return;

  voiceDrafts[role] = null;

  const previous = textMessages.at(-1);
  if (previous?.role === role && previous?.channel === "voice" && previous.provisional) {
    previous.content = content;
    previous.provisional = false;
    previous.liveAvatarEventId = eventId || null;
    if (eventId) receivedVoiceEventIds.add(eventId);
    saveTranscript();
    syncTextTranscriptToSessionLog();
    return;
  }
  if (previous?.role === role && previous?.channel === "voice" && previous.content === content) {
    if (eventId) receivedVoiceEventIds.add(eventId);
    return;
  }

  if (eventId) receivedVoiceEventIds.add(eventId);
  textMessages.push({
    role,
    channel: "voice",
    content,
    timestamp: new Date().toISOString(),
    liveAvatarEventId: eventId || null,
  });
  saveTranscript();
  syncTextTranscriptToSessionLog();
  logSessionEvent(`${role === "assistant" ? "avatar" : "user"}_transcription_received`, {
    liveAvatarEventId: eventId || null,
    characterCount: content.length,
  });
}

function isLowValueUserTranscription(content) {
  const normalized = content.trim().toLowerCase();
  if (normalized.length < 2 || !/[a-z0-9]/i.test(normalized)) return true;
  return /^(?:uh+|um+|h+m+|mm+|ah+|er+)[.!?,\s]*$/i.test(normalized);
}

function mergeTranscriptChunk(current, next) {
  if (!current) return next.trimStart();
  if (!next) return current;

  const nextWithoutLeadingSpace = next.trimStart();
  if (nextWithoutLeadingSpace.startsWith(current)) return nextWithoutLeadingSpace;
  if (current.includes(nextWithoutLeadingSpace)) return current;

  let overlap = Math.min(current.length, next.length);
  while (overlap > 0 && current.slice(-overlap) !== next.slice(0, overlap)) overlap -= 1;

  // LiveAvatar chunks normally contain consecutive text. A one-character match at
  // the boundary is usually two adjacent words that happen to share a letter
  // (for example "are" + "estimates"), not overlapping content.
  if (overlap >= 4) return current + next.slice(overlap);

  if (/\s$/.test(current) || /^\s/.test(next)) return current + next;
  if (/^[.,!?;:%)\]}]/.test(next)) return current + next;
  if (/[([{]$/.test(current)) return current + next;
  if (/^[’'](?:s|t|re|ve|ll|d|m)\b/i.test(next)) return current + next;
  return `${current} ${next}`;
}

function appendVoiceTranscriptionChunk(event, role) {
  const chunk = String(event?.text ?? "");
  if (!chunk.trim()) return;
  const current = voiceDrafts[role]?.content || "";
  voiceDrafts[role] = {
    role,
    channel: "voice",
    content: mergeTranscriptChunk(current, chunk),
    timestamp: voiceDrafts[role]?.timestamp || new Date().toISOString(),
  };
  renderTranscript();
}

function flushVoiceDraft(role) {
  const draft = voiceDrafts[role];
  if (!draft?.content) return;
  voiceDrafts[role] = null;
  if (role === "user" && isLowValueUserTranscription(draft.content)) {
    renderTranscript();
    return;
  }
  textMessages.push({ ...draft, provisional: true });
  saveTranscript();
  syncTextTranscriptToSessionLog();
}

function flushAllVoiceDrafts() {
  flushVoiceDraft("user");
  flushVoiceDraft("assistant");
}

function clearPreviousConversation() {
  textMessages = [];
  voiceDrafts.user = null;
  voiceDrafts.assistant = null;
  receivedVoiceEventIds.clear();
  sessionStorage.removeItem(TEXT_TRANSCRIPT_KEY);
  renderTranscript();
  syncTextTranscriptToSessionLog();
  textChatInput.value = "";
  textChatStatus.textContent = "";
}

function ensureTextFallbackGreeting() {
  if (textMessages.length > 0) return;
  textMessages.push({
    role: "assistant",
    content: "Hi, I'm your virtual health educator. I'm here to help you understand your breast cancer risk results. This is not a diagnosis, and I'm not a clinician. What would you like help understanding?",
    timestamp: new Date().toISOString(),
    channel: "text",
  });
  saveTranscript();
  syncTextTranscriptToSessionLog();
}

conversationConsent.addEventListener("change", () => {
  const enabled = conversationConsent.checked && Boolean(result);
  avatarPicker.classList.toggle("hidden", !enabled);
  // Text chat is independent of LiveAvatar/Railway and should remain usable
  // even when the video session cannot be created or connected.
  textConversation.classList.toggle("hidden", !enabled);
  explainRiskButton.disabled = !enabled;
  if (enabled) {
    explainRiskStatus.textContent = "Choose an educator, then start the conversation.";
    logSessionEvent("conversation_consent_given");
  } else {
    setAvatarPickerLocked(false);
    avatarChoices.forEach((choice, index) => { choice.checked = index === 0; });
    syncAvatarPlaceholder();
    explainRiskStatus.textContent = "";
    logSessionEvent("conversation_consent_removed");
  }
});

explainRiskButton.addEventListener("click", async () => {
  if (!result || !conversationConsent.checked) return;

  conversationDocumentActions.classList.remove("hidden");
  conversationNavigationActions.classList.remove("hidden");
  clearPreviousConversation();
  setAvatarPickerLocked(true);
  explainRiskButton.disabled = true;
  const sessionLog = readSessionLog();
  if (sessionLog && !sessionLog.timestamps?.conversationStartedAt) {
    sessionLog.timestamps.conversationStartedAt = new Date().toISOString();
    writeSessionLog(sessionLog);
  }
  logSessionEvent("voice_conversation_start_requested");
  updateConversationLog({ channel: "voice", status: "starting" });
  avatarConnection.classList.remove("hidden");
  textConversation.classList.remove("hidden");
  microphoneStatus.textContent = "Microphone off.";

  // Text chat uses the Cloudflare/Groq endpoint directly and does not require
  // a LiveAvatar session. When credits are exhausted, start in text-only mode
  // instead of making a billable session request that is guaranteed to fail.
  if (liveAvatarCreditsAvailable === null) await refreshLiveAvatarCredits();
  if (liveAvatarCreditsAvailable === false) {
    avatarConnection.classList.remove("hidden");
    showFallback("LiveAvatar credits are unavailable. Continue with the text conversation below.");
    ensureTextFallbackGreeting();
    setSessionState("Text only", "disconnected");
    setAvatarPickerLocked(false);
    updateConversationLog({ channel: "text", status: "connected", fallbackAvailable: true });
    logSessionEvent("text_only_conversation_started", { reason: "liveavatar_credits_exhausted" });
    explainRiskButton.disabled = false;
    textChatInput.focus();
    return;
  }

  try {
    explainRiskStatus.textContent = "Starting a LiveAvatar LITE conversation with the grounded risk educator…";
    avatarStatus.textContent = "Creating secure LiveAvatar session…";
    setSessionState("Starting", "connecting");

    const avatarKey = selectedAvatarKey();
    syncAvatarPlaceholder();
    currentSession = await postJson("/api/liveavatar/session", { riskResult: result, avatarKey });
    sessionStorage.setItem("liveAvatarSession", JSON.stringify(currentSession));
    {
      const sessionLog = readSessionLog();
      if (sessionLog) {
        sessionLog.avatar = sessionLog.avatar || {};
        sessionLog.avatar.liveStatus = "session_created";
        sessionLog.avatar.liveAvatarSessionId = currentSession.sessionId || null;
        sessionLog.avatar.mode = currentSession.mode || null;
        sessionLog.avatar.sandbox = Boolean(currentSession.sandbox);
        sessionLog.avatar.selectedKey = avatarKey;
        writeSessionLog(sessionLog);
      }
    }
    logSessionEvent("liveavatar_session_created", { liveAvatarSessionId: currentSession.sessionId || null, sandbox: Boolean(currentSession.sandbox) });

    await connectLiveAvatarSession(currentSession);
    explainRiskStatus.textContent = "";
    updateConversationLog({ channel: "voice", status: "connected", liveAvatarSessionId: currentSession?.sessionId || null });
    logSessionEvent("voice_conversation_connected");
  } catch (error) {
    const failedSessionId = currentSession?.sessionId || null;
    const failedRoom = liveAvatarSession;
    sessionEndRequested = true;
    liveAvatarSession = null;
    if (failedRoom) {
      await stopLiveAvatarSession(failedRoom, 5000, failedSessionId).catch((stopError) => {
        console.error("Unable to stop failed LiveAvatar session", stopError);
      });
    }
    clearStoredLiveAvatarSession();
    setAvatarPickerLocked(false);
    console.error(error);
    const message = error instanceof Error ? error.message : "Unable to start the avatar session.";
    explainRiskStatus.textContent = `${message} You can continue by text below.`;
    avatarStatus.textContent = "Avatar session was not started.";
    setSessionState("Unavailable", "disconnected");
    reconnectButton.classList.remove("hidden");
    showFallback("Video is unavailable. Continue with the text conversation below or try reconnecting later.");
    ensureTextFallbackGreeting();
    updateConversationLog({ status: "voice_unavailable", fallbackAvailable: true });
    logSessionEvent("voice_conversation_start_failed", { error: message });
  } finally {
    explainRiskButton.disabled = false;
  }
});

muteButton.addEventListener("click", async () => {
  if (!liveAvatarSession) return;
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone access requires HTTPS or localhost in a supported browser.");
    }

    const enableMicrophone = !liveAvatarSession.localParticipant.isMicrophoneEnabled;
    if (enableMicrophone) microphoneStatus.textContent = "Requesting microphone access…";
    await liveAvatarSession.localParticipant.setMicrophoneEnabled(enableMicrophone);
    microphoneMuted = !liveAvatarSession.localParticipant.isMicrophoneEnabled;
    updateMuteButton();
    microphoneStatus.textContent = microphoneMuted ? "Microphone muted." : "Microphone on.";
    logSessionEvent(microphoneMuted ? "microphone_muted" : "microphone_unmuted");
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Unable to enable the microphone.";
    microphoneMuted = true;
    updateMuteButton();
    microphoneStatus.textContent = `${message} You can continue by text.`;
    logSessionEvent("microphone_enable_failed", { error: message });
  }
});

enableAudioButton.addEventListener("click", async () => {
  const media = avatarStage.querySelector("audio") || avatarStage.querySelector("video");
  if (!media) return;
  if (!media.paused && !media.muted) {
    enableAudioButton.classList.add("hidden");
    return;
  }
  try {
    media.muted = false;
    await media.play();
    enableAudioButton.classList.add("hidden");
  } catch (error) {
    console.error(error);
    avatarStatus.textContent = "Audio playback is still blocked by the browser. Text chat remains available.";
  }
});

reconnectButton.addEventListener("click", async () => {
  reconnectButton.disabled = true;
  logSessionEvent("avatar_reconnect_requested");
  try {
    if (liveAvatarSession) await stopLiveAvatarSession(liveAvatarSession).catch(() => {});
    liveAvatarSession = null;
    clearStoredLiveAvatarSession();
    reconnectButton.classList.add("hidden");
    explainRiskButton.click();
  } catch (error) {
    console.error(error);
    explainRiskStatus.textContent = "Reconnect failed. Continue by text or start a new voice session.";
    showFallback("Reconnection failed. The text conversation is still available.");
    logSessionEvent("avatar_reconnect_failed", { error: error instanceof Error ? error.message : String(error) });
  } finally {
    reconnectButton.disabled = false;
  }
});

async function endCurrentSession() {
  sessionEndRequested = true;
  flushAllVoiceDrafts();
  endConversationButton.classList.add("hidden");
  endConversationButton.disabled = true;
  const sdkSession = liveAvatarSession;
  liveAvatarSession = null;
  const endedLiveAvatarSessionId = currentSession?.sessionId || null;
  try {
    if (sdkSession) await stopLiveAvatarSession(sdkSession, 5000, endedLiveAvatarSessionId);
  } catch (error) {
    console.warn("LiveAvatar stop failed", error);
  } finally {
    finalizeEndedSessionUi();

    const sessionLog = readSessionLog();
    if (sessionLog) {
      sessionLog.timestamps = sessionLog.timestamps || {};
      sessionLog.timestamps.conversationEndedAt = new Date().toISOString();
      sessionLog.avatar = sessionLog.avatar || {};
      sessionLog.avatar.liveStatus = "ended";
      writeSessionLog(sessionLog);
    }
  }
  updateConversationLog({ status: "ended", liveAvatarSessionId: endedLiveAvatarSessionId });
  logSessionEvent("conversation_ended", { liveAvatarSessionId: endedLiveAvatarSessionId });
  void refreshLiveAvatarCredits();
}

endConversationButton.addEventListener("click", endCurrentSession);

transcriptButton.addEventListener("click", () => {
  textConversation.classList.remove("hidden");
  textConversation.scrollIntoView({ behavior: "smooth", block: "start" });
  window.setTimeout(() => textConversationHeading.focus({ preventScroll: true }), 350);
});

textChatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!result || !conversationConsent.checked) return;

  const userText = textChatInput.value.trim();
  if (!userText) return;

  textMessages.push({ role: "user", content: userText, timestamp: new Date().toISOString() });
  logSessionEvent("text_message_sent", { characterCount: userText.length });
  saveTranscript();
  textChatInput.value = "";
  sendTextButton.disabled = true;
  textChatStatus.textContent = "Generating a grounded response…";

  try {
    if (liveAvatarSession?.state === "connected" && currentSession?.sessionId) {
      try {
        const payload = new TextEncoder().encode(JSON.stringify({
          type: "user_message",
          text: userText,
        }));
        await liveAvatarSession.localParticipant.publishData(payload, {
          reliable: true,
          topic: "bc-risk-user-message",
        });
        textChatStatus.textContent = "Your message was sent to the avatar.";
        logSessionEvent("text_message_sent_to_avatar", { characterCount: userText.length });
        return;
      } catch (error) {
        console.warn("Unable to send text through LiveAvatar; using text fallback", error);
        logSessionEvent("text_message_avatar_send_failed", { characterCount: userText.length });
        textChatStatus.textContent = "Video messaging is unavailable. Using text chat…";
      }
    }

    const response = await postJson("/api/chat", {
      riskResult: result,
      stage: textMessages.length <= 1 ? "initial_explanation" : "follow_up",
      messages: textMessages.slice(-12).map(({ role, content }) => ({ role, content })),
    });

    textMessages.push({
      role: "assistant",
      content: response.reply || "I’m unable to answer that right now.",
      timestamp: new Date().toISOString(),
      moduleIds: response.moduleIds || [],
    });
    logSessionEvent("text_response_received", { moduleIds: response.moduleIds || [] });
    saveTranscript();
    textChatStatus.textContent = "";
  } catch (error) {
    console.error(error);
    textChatStatus.textContent = error instanceof Error ? error.message : "Text response failed.";
  } finally {
    sendTextButton.disabled = false;
    textChatInput.focus();
  }
});

textChatInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  if (!sendTextButton.disabled && textChatInput.value.trim()) {
    textChatForm.requestSubmit();
  }
});

clearTranscriptButton.addEventListener("click", () => {
  textMessages = [];
  saveTranscript();
  textChatStatus.textContent = "Text transcript cleared on this device.";
  logSessionEvent("text_transcript_cleared");
});


downloadJsonButton?.addEventListener("click", () => {
  const snapshot = buildExportSnapshot();
  const filename = `breast-risk-session-${snapshot.sessionId || "export"}.json`;
  downloadBlob(filename, JSON.stringify(snapshot, null, 2), "application/json");
  logSessionEvent("session_log_exported", { format: "json" });
});

printRiskButton?.addEventListener("click", () => {
  window.open("results.html?print=1", "_blank", "noopener");
});

saveTranscriptButton?.addEventListener("click", () => {
  flushAllVoiceDrafts();
  if (!textMessages.length) {
    textChatStatus.textContent = "There is no transcript to save yet.";
    return;
  }

  const lines = [
    "BC Risk Educator conversation transcript",
    `Saved: ${new Date().toLocaleString()}`,
    "",
    ...textMessages.flatMap((message) => [
      `${message.role === "user" ? "You" : "AI health educator"}:`,
      message.content,
      "",
    ]),
  ];
  const date = new Date().toISOString().slice(0, 10);
  downloadBlob(`bc-risk-educator-transcript-${date}.txt`, lines.join("\n"), "text/plain;charset=utf-8");
  textChatStatus.textContent = "Transcript saved.";
  logSessionEvent("transcript_downloaded", { format: "txt", turnCount: textMessages.length });
});

syncTextTranscriptToSessionLog();
renderAnswerSummary();

renderTranscript();
syncAvatarPlaceholder();
void refreshLiveAvatarCredits();
window.addEventListener("beforeunload", () => {
  const sessionId = currentSession?.sessionId;
  if (sessionId) {
    void fetch("/api/liveavatar/session", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
      keepalive: true,
    });
  }
  if (liveAvatarSession) void liveAvatarSession.disconnect();
});
