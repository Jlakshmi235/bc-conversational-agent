# Conversational Agent for Breast Cancer Risk Communication

### Summary
This is a responsive web application that combines a breast-cancer risk calculator with a conversational AI agent. After completing the assessment, a user receives estimated five-year and lifetime breast-cancer risk results and can discuss them with a real-time, on-screen avatar. The conversation explains the estimates in plain language, compares them with age-based averages, and follows a risk-specific pathway: users with low or average risk receive reassurance and general prevention guidance, while users with elevated risk are encouraged to discuss the result with a qualified healthcare professional. 

## Architecture

```text
Browser microphone → LiveAvatar-hosted LiveKit room → Python agent
Python agent: STT → Cloudflare RAG proxy → Groq → TTS
TTS audio → LiveAvatar WebSocket → lip-synced avatar video → browser
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

