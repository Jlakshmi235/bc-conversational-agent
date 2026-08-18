# LiveAvatar LITE agent service

This service is based on LiveAvatar's official custom LiveKit agent pathway. LiveAvatar owns the room; this service joins with the returned agent token and stays alive for the session.

## Required accounts

- LiveAvatar API key and three avatar IDs
- LiveKit Cloud API key and secret for the inference gateway
- A deployed BC Risk Educator Worker with `/openai/v1/chat/completions`

## Configuration

```bash
cp .env.example .env.local
```

Set:

- `LIVEAVATAR_API_KEY`
- `LIVEAVATAR_AVATAR_ID`, `_2`, and `_3`
- `LIVEAVATAR_SANDBOX=true` while testing
- `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`
- `LLM_PROXY_BASE_URL=https://<worker-domain>/openai/v1`
- `LLM_PROXY_TOKEN` matching the Worker secret
- `AGENT_SHARED_SECRET` matching `LITE_AGENT_SHARED_SECRET` on the Worker
- `STT_MODEL` and `TTS_MODEL`
- `TTS_VOICE_ID`, `_2`, and `_3`

The TTS IDs belong to the configured TTS provider, not LiveAvatar. LiveAvatar voice IDs are not used in this custom LITE pipeline.

## Run locally

```bash
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/python -m livekit.agents download-files
.venv/bin/uvicorn src.service:app --host 127.0.0.1 --port 8080
```

Health check:

```bash
curl http://127.0.0.1:8080/health
```

## Container deployment

```bash
docker build -t bc-risk-liveavatar-lite-agent .
docker run --env-file .env.local -p 8080:8080 bc-risk-liveavatar-lite-agent
```

Deploy the image to a service that supports long-running processes and outbound HTTPS/WSS connections. Keep one Uvicorn worker per instance: active room ownership is held in process memory. Do not use request-only serverless functions for this service.

Production requirements:

- Public HTTPS endpoint reachable by the Cloudflare Worker
- Outbound access to LiveAvatar, LiveKit, the Worker LLM proxy, and inference providers
- Graceful SIGTERM handling
- A maximum LiveAvatar session duration as a leaked-session safety net
- Health checks against `/health`
- Secrets stored in the hosting platform, never committed

## HTTP contract

The Cloudflare Worker calls:

- `POST /sessions` with `X-Agent-Secret`
- `DELETE /sessions/{session_id}` with `X-Agent-Secret`

Viewer credentials are returned to the Worker/browser. Agent tokens and the LiveAvatar media WebSocket URL remain inside this service.

## Tests

```bash
.venv/bin/ruff check src tests
.venv/bin/python -m compileall -q src
.venv/bin/pytest -q
```
