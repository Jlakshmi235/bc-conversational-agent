# BC Risk Educator

Breast-cancer risk calculator and grounded AI health educator. The web application runs on Cloudflare Workers and the real-time avatar uses LiveAvatar **LITE mode** with a separate Python LiveKit agent.

## Architecture

```text
Browser microphone → LiveAvatar-hosted LiveKit room → Python agent
Python agent: STT → Cloudflare RAG proxy → Groq → TTS
TTS audio → LiveAvatar WebSocket → lip-synced avatar video → browser
```

The calculator, results, deterministic medical-risk retrieval, text fallback, transcript, downloads, and avatar-selection UI remain in this repository. The long-running voice agent lives in [`agent-service`](./agent-service).

## Web application: local development

```bash
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

## LITE agent: local development

Create a LiveKit Cloud project for the STT/TTS inference gateway, then follow [`agent-service/README.md`](./agent-service/README.md).

For local development, run the agent service alongside Vite:

```bash
cd agent-service
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
cp .env.example .env.local
.venv/bin/uvicorn src.service:app --host 127.0.0.1 --port 8080
```

The same value must be used for:

- Cloudflare/Vite: `LITE_AGENT_SHARED_SECRET`
- Agent service: `AGENT_SHARED_SECRET`

The agent's `LLM_PROXY_BASE_URL` should be `http://localhost:5173/openai/v1` locally and the deployed Cloudflare URL plus `/openai/v1` in production. Its `LLM_PROXY_TOKEN` must match the Worker's `LLM_PROXY_TOKEN`.

## Cloudflare deployment

Configure these Worker secrets/variables:

- `GROQ_API_KEY`
- `GROQ_MODEL`
- `LLM_PROXY_TOKEN`
- `LIVEAVATAR_API_KEY` (used by the credit-balance endpoint)
- `LIVEAVATAR_AGENT_URL` (public HTTPS URL of the Python service)
- `LITE_AGENT_SHARED_SECRET`

Then deploy:

```bash
npm run deploy
```

`keep_vars` is enabled in `wrangler.jsonc`, so dashboard-managed secrets are preserved.

## Grounding and privacy

The Worker retains the existing deterministic retrieval behavior:

- `scope-and-safety` is always included.
- The application selects the low/average or elevated branch from the calculated result.
- Follow-up knowledge modules are selected from the current user message.
- The Python agent calls the Worker's OpenAI-compatible proxy for every turn.
- The Worker applies risk-specific retrieval and then forwards the request to Groq.

Risk context is sent only to the configured agent service and LLM proxy. Keep both shared secrets private, use HTTPS in production, avoid logging prompts or transcripts, and configure an appropriate retention policy for any production healthcare deployment.

## Session behavior

- LiveAvatar mode: `LITE`
- Video transport: LiveAvatar-hosted LiveKit room, H264
- Browser microphone: published directly to LiveKit
- STT/TTS: LiveKit inference gateway models configured in the agent service
- LLM: the existing Cloudflare RAG proxy and Groq model
- Voice transcript: published by the agent to the browser over a reliable LiveKit data topic
- Text fallback: remains available through `POST /api/chat`
- Ending a session: the browser disconnects and the Worker asks the agent service to stop its pipeline and LiveAvatar session

## Verification

```bash
npm run build

cd agent-service
.venv/bin/ruff check src tests
.venv/bin/python -m compileall -q src
.venv/bin/pytest -q
```
