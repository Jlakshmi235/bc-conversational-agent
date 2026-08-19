# Conversational Agent for Breast Cancer Risk Communication

## Project summary

BC Risk Educator is a responsive web application that combines a breast-cancer risk calculator with a conversational AI health educator. It is designed to make numerical risk estimates easier to understand, reduce unnecessary worry, and encourage an appropriate next step when a result is elevated.

After completing the assessment, a user receives estimated five-year and lifetime breast-cancer risk results and can discuss them with a real-time, on-screen avatar. The conversation explains the estimates in plain language, compares them with age-based averages, and follows a risk-specific pathway: users with low or average risk receive reassurance and general prevention guidance, while users with elevated risk are encouraged to discuss the result with a qualified healthcare professional. Conversations are intended to remain focused and brief, typically lasting two to five minutes.

Responses are grounded in a curated evidence base containing clinical guidance, reputable patient-education resources, and relevant behavioral-science principles. The educator does not diagnose, predict an individual's outcome, or present itself as a clinician. Visible consent and medical disclaimers reinforce these boundaries. If video, audio, microphone access, LiveAvatar, or the voice pipeline is unavailable, the same grounded conversation remains accessible through the text interface.

The project has two connected components:

1. **Web application:** A responsive Cloudflare Workers application containing the breast-cancer risk calculator, results page, and risk-explanation conversation window. The conversation window embeds the LiveAvatar video, provides a text chat and transcript, and remains usable as a text-only experience when video or voice is unavailable. The web application also performs deterministic retrieval from the curated knowledge base before requests are sent to Groq.
2. **Voice agent:** A separate Python LiveKit service that manages the real-time voice pipeline. It receives the user's microphone audio from the LiveKit room, converts speech to text, sends the transcript and relevant risk context to the grounded LLM through the Cloudflare proxy, converts the LLM response to speech, and streams that audio to LiveAvatar for lip-synced delivery. It also publishes user and educator transcripts back to the web application.

Together, these components support LiveAvatar **LITE mode**, text fallback, transcripts, session metadata, downloadable session JSON, and saved risk estimates for later review.

## Architecture

```text
Web application (Cloudflare Workers)
  Calculator → results → explanation window
                         ├─ LiveAvatar video
                         └─ text chat and transcript

Voice agent (Python + LiveKit)
  Browser microphone → speech-to-text → Cloudflare RAG proxy → Groq LLM
  Groq response → text-to-speech → LiveAvatar → lip-synced video and audio
```

The calculator, results, deterministic medical-risk retrieval, text fallback, transcript, downloads, and avatar-selection UI remain in this repository. The long-running voice agent lives in [`agent-service`](./agent-service).

## Web application: local development

```bash
git clone https://github.com/Jlakshmi235/bc-conversational-agent.git
cd bc-conversational-agent
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Configure these values in `.dev.vars`:

```env
GROQ_API_KEY=...
GROQ_MODEL=openai/gpt-oss-120b
LLM_PROXY_TOKEN=<shared LLM proxy secret>

LIVEAVATAR_API_KEY=...
LIVEAVATAR_AGENT_URL=http://127.0.0.1:8080
LITE_AGENT_SHARED_SECRET=<shared agent service secret>
```

Open `http://localhost:5173/calculator/`.

## Voice agent: local development

Create a LiveKit Cloud project for the STT/TTS inference gateway, then follow [`agent-service/README.md`](./agent-service/README.md).

For local development:

```bash
cd agent-service
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
cp .env.example .env.local
.venv/bin/uvicorn src.service:app --host 127.0.0.1 --port 8080
```

The same value must be used for:

- Cloudflare: `LITE_AGENT_SHARED_SECRET`
- Agent service: `AGENT_SHARED_SECRET`

The agent's `LLM_PROXY_BASE_URL` should be `http://localhost:5173/openai/v1` locally and the deployed Cloudflare URL plus `/openai/v1` in production. Its `LLM_PROXY_TOKEN` must match the Worker's `LLM_PROXY_TOKEN`.


## Session behavior

- LiveAvatar mode: `LITE`
- Video transport: LiveAvatar-hosted LiveKit room, H264
- Browser microphone: published directly to LiveKit
- STT/TTS: LiveKit inference gateway models configured in the agent service
- LLM: the existing Cloudflare RAG proxy and Groq model
- Voice transcript: published by the agent to the browser over a reliable LiveKit data topic
- Text fallback: remains available through `POST /api/chat`
- Ending a session: the browser disconnects and the Worker asks the agent service to stop its pipeline and LiveAvatar session
