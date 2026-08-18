from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Response
from livekit import rtc
from livekit.agents.utils import http_context
from livekit.plugins import silero
from pydantic import BaseModel, Field

from .agent import BreastRiskAgent
from .avatar_ws import AvatarWebSocket
from .liveavatar_client import LiveAvatarClient, StartedSession
from .pipeline import (
    build_room_options,
    build_session,
    mute_agent_audio_on_publish,
    publish_transcript,
    wire_room_observability,
    wire_transcripts,
    wire_typed_messages,
)

load_dotenv(".env.local")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger("service")


class StartSessionRequest(BaseModel):
    avatar_key: str = Field(pattern=r"^avatar-[123]$")
    system_prompt: str = Field(min_length=20, max_length=50_000)
    opening_text: str = Field(min_length=1, max_length=1_000)


class AgentRuntime:
    def __init__(self, started: StartedSession, request: StartSessionRequest, avatar_id: str) -> None:
        self.started = started
        self.request = request
        self.avatar_id = avatar_id
        self.room = rtc.Room()
        self.avatar_ws = AvatarWebSocket(started.ws_url)
        self.agent_session = None
        self._closed = False

    async def start(self, vad) -> None:
        await self.avatar_ws.connect()
        await self.room.connect(self.started.livekit_url, self.started.livekit_agent_token)
        mute_agent_audio_on_publish(self.room)
        wire_room_observability(self.room)

        voice_suffix = self.request.avatar_key.removeprefix("avatar-")
        voice_env = "TTS_VOICE_ID" if voice_suffix == "1" else f"TTS_VOICE_ID_{voice_suffix}"
        voice_id = os.environ.get(voice_env) or os.environ["TTS_VOICE_ID"]
        if inference_http_session is None:
            raise RuntimeError("LiveKit inference HTTP session is not initialized.")
        self.agent_session = build_session(
            vad,
            tts_voice_id=voice_id,
            http_session=inference_http_session,
        )
        wire_transcripts(self.agent_session, self.room)
        wire_typed_messages(self.agent_session, self.room)

        async def publish_assistant_transcript(text: str, final: bool) -> None:
            await publish_transcript(
                self.room,
                role="assistant",
                text=text,
                final=final,
            )

        await self.agent_session.start(
            agent=BreastRiskAgent(
                self.avatar_ws,
                self.request.system_prompt,
                publish_assistant_transcript,
            ),
            room=self.room,
            room_options=build_room_options(participant_identity="client"),
        )
        self.agent_session.generate_reply(instructions=self.request.opening_text)

    async def close(self, reason: str = "USER_CLOSED") -> None:
        if self._closed:
            return
        self._closed = True
        if self.agent_session is not None:
            with contextlib.suppress(Exception):
                await self.agent_session.aclose()
        with contextlib.suppress(Exception):
            await self.room.disconnect()
        with contextlib.suppress(Exception):
            await self.avatar_ws.close()
        async with LiveAvatarClient(
            os.environ["LIVEAVATAR_API_KEY"],
            os.environ.get("LIVEAVATAR_BASE_URL", "https://api.liveavatar.com"),
        ) as client:
            with contextlib.suppress(Exception):
                await client.stop_session(
                    self.started.session_token,
                    # Internal cleanup reasons such as ROOM_DISCONNECTED and
                    # SERVER_SHUTDOWN are not accepted by LiveAvatar's API.
                    "USER_CLOSED",
                )


runtimes: dict[str, AgentRuntime] = {}
vad_model = None
inference_http_session = None


async def require_shared_secret(x_agent_secret: str = Header(default="")) -> None:
    expected = os.environ.get("AGENT_SHARED_SECRET", "")
    if not expected or x_agent_secret != expected:
        raise HTTPException(status_code=401, detail="Unauthorized")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global inference_http_session, vad_model
    vad_model = silero.VAD.load()
    async with http_context.open() as shared_http_session:
        inference_http_session = shared_http_session
        yield
        await asyncio.gather(*(runtime.close("SERVER_SHUTDOWN") for runtime in runtimes.values()))
        inference_http_session = None


app = FastAPI(title="BC Risk LiveAvatar LITE Agent", lifespan=lifespan)


async def cleanup_runtime(session_id: str, reason: str) -> None:
    runtime = runtimes.pop(session_id, None)
    if runtime:
        await runtime.close(reason)


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "activeSessions": len(runtimes)}


@app.post("/sessions", dependencies=[Depends(require_shared_secret)])
async def create_session(request: StartSessionRequest) -> dict:
    avatar_suffix = request.avatar_key.removeprefix("avatar-")
    avatar_env = "LIVEAVATAR_AVATAR_ID" if avatar_suffix == "1" else f"LIVEAVATAR_AVATAR_ID_{avatar_suffix}"
    avatar_id = os.environ.get(avatar_env, "")
    if not avatar_id or avatar_id == "replace_me":
        raise HTTPException(status_code=500, detail=f"{avatar_env} is not configured")

    max_duration = int(os.environ.get("LIVEAVATAR_MAX_SESSION_DURATION", "60"))
    is_sandbox = os.environ.get("LIVEAVATAR_SANDBOX", "false").lower() == "true"
    async with LiveAvatarClient(
        os.environ["LIVEAVATAR_API_KEY"],
        os.environ.get("LIVEAVATAR_BASE_URL", "https://api.liveavatar.com"),
    ) as client:
        started = await client.start_lite_session(
            avatar_id=avatar_id,
            is_sandbox=is_sandbox,
            max_session_duration=max_duration,
        )

    runtime = AgentRuntime(started, request, avatar_id)
    try:
        await asyncio.wait_for(runtime.start(vad_model), timeout=30)
    except Exception:
        await runtime.close("AGENT_START_FAILED")
        raise
    runtimes[started.session_id] = runtime

    @runtime.room.on("disconnected")
    def _room_disconnected(_reason=None) -> None:
        asyncio.create_task(cleanup_runtime(started.session_id, "ROOM_DISCONNECTED"))

    return {
        "mode": "LITE",
        "sandbox": is_sandbox,
        "sessionId": started.session_id,
        "livekitUrl": started.livekit_url,
        "livekitClientToken": started.livekit_client_token,
        "maxSessionDuration": started.max_session_duration,
        "avatarKey": request.avatar_key,
    }


@app.delete("/sessions/{session_id}", status_code=204, dependencies=[Depends(require_shared_secret)])
async def stop_session(session_id: str) -> Response:
    await cleanup_runtime(session_id, "USER_CLOSED")
    return Response(status_code=204)
