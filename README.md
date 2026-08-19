# Conversational Agent for Breast Cancer Risk Communication

## Project summary

This is a responsive web application that combines a breast-cancer risk calculator with a conversational AI agent. After completing the assessment, a user receives estimated five-year and lifetime breast-cancer risk results (based on NCI Gail model) and can discuss them with a real-time, on-screen avatar. 

The project has two connected components:

```text
Web application (Cloudflare Workers)
  Calculator → results → explanation window
                         ├─ LiveAvatar video
                         └─ text chat and transcript

Voice agent (Python + LiveKit)
  Browser microphone → speech-to-text → Cloudflare RAG proxy → Groq LLM
  Groq response → text-to-speech → LiveAvatar → lip-synced video and audio
```

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

Voice agent code lives in [`agent-service`](./agent-service).
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
