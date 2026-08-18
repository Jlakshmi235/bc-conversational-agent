from __future__ import annotations

import asyncio
import json
import logging
import os

from aiohttp import ClientSession
from livekit import rtc
from livekit.agents import AgentSession, inference, room_io
from livekit.plugins import openai

logger = logging.getLogger("pipeline")


def build_session(
    vad,
    *,
    tts_voice_id: str,
    http_session: ClientSession,
) -> AgentSession:
    groq_model = os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b")
    groq_llm = openai.LLM(
        model=groq_model,
        api_key=os.environ["LLM_PROXY_TOKEN"],
        base_url=os.environ["LLM_PROXY_BASE_URL"].rstrip("/"),
    )
    return AgentSession(
        stt=inference.STT(
            model=os.environ.get("STT_MODEL", "deepgram/nova-3"),
            language="en",
            http_session=http_session,
        ),
        llm=groq_llm,
        tts=inference.TTS(
            model=os.environ.get("TTS_MODEL", "cartesia/sonic-3"),
            voice=tts_voice_id,
            http_session=http_session,
        ),
        turn_detection=inference.TurnDetector(),
        vad=vad,
        preemptive_generation=True,
    )


def build_room_options(*, participant_identity: str) -> room_io.RoomOptions:
    return room_io.RoomOptions(
        # The LiveAvatar renderer is already in the room when the agent joins.
        # Pin input to the browser so STT never binds to the renderer instead.
        participant_identity=participant_identity,
        audio_input=room_io.AudioInputOptions(
            # The browser already applies echo cancellation, noise suppression,
            # and gain control. A second enhancement pass can suppress quiet
            # laptop microphones before VAD/STT receives them.
            noise_cancellation=None,
            auto_gain_control=True,
        ),
    )


def mute_agent_audio_on_publish(room: rtc.Room) -> None:
    @room.on("local_track_published")
    def _mute_agent_track(publication, track) -> None:
        if publication.kind == rtc.TrackKind.KIND_AUDIO and isinstance(track, rtc.LocalAudioTrack):
            track.mute()


def wire_room_observability(room: rtc.Room) -> None:
    @room.on("participant_connected")
    def _participant_connected(participant) -> None:
        logger.info(
            "LiveKit participant connected: identity=%s kind=%s",
            participant.identity,
            participant.kind,
        )

    @room.on("track_subscribed")
    def _track_subscribed(track, publication, participant) -> None:
        logger.info(
            "LiveKit track subscribed: kind=%s source=%s participant=%s",
            track.kind,
            publication.source,
            participant.identity,
        )

    @room.on("active_speakers_changed")
    def _active_speakers_changed(participants) -> None:
        identities = [participant.identity for participant in participants]
        if identities:
            logger.info("LiveKit active speakers: %s", identities)


async def publish_transcript(room: rtc.Room, *, role: str, text: str, final: bool = True) -> None:
    if not text.strip():
        return
    transcript_text = text.strip() if final else text
    payload = json.dumps(
        {"type": "transcript", "role": role, "text": transcript_text, "final": final}
    ).encode("utf-8")
    await room.local_participant.publish_data(payload, reliable=True, topic="bc-risk-transcript")


def wire_transcripts(session: AgentSession, room: rtc.Room) -> None:
    @session.on("user_input_transcribed")
    def _user_transcribed(event) -> None:
        text = str(getattr(event, "transcript", "") or "")
        final = bool(getattr(event, "is_final", False))
        if text:
            logger.info("User input transcribed: final=%s text=%r", final, text)
            asyncio.create_task(publish_transcript(room, role="user", text=text, final=final))


def wire_typed_messages(session: AgentSession, room: rtc.Room) -> None:
    @room.on("data_received")
    def _typed_message_received(packet: rtc.DataPacket) -> None:
        if packet.topic != "bc-risk-user-message":
            return
        try:
            payload = json.loads(packet.data.decode("utf-8"))
            text = str(payload.get("text") or "").strip()
            if payload.get("type") != "user_message" or not text:
                return
            if len(text) > 1_000:
                logger.warning("Ignoring typed message longer than 1,000 characters.")
                return
            session.generate_reply(
                user_input=text,
                input_modality="text",
                allow_interruptions=True,
            )
        except (UnicodeDecodeError, json.JSONDecodeError, AttributeError, TypeError):
            logger.warning("Ignoring malformed typed-message data packet.")
