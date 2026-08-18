from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterable, Awaitable, Callable

from livekit import rtc
from livekit.agents import Agent, ModelSettings

from .avatar_ws import AvatarWebSocket


class BreastRiskAgent(Agent):
    def __init__(
        self,
        avatar_ws: AvatarWebSocket,
        instructions: str,
        publish_assistant_transcript: Callable[[str, bool], Awaitable[None]],
    ) -> None:
        super().__init__(instructions=instructions)
        self._avatar_ws = avatar_ws
        self._publish_assistant_transcript = publish_assistant_transcript

    async def tts_node(
        self,
        text: AsyncIterable[str],
        model_settings: ModelSettings,
    ) -> AsyncIterable[rtc.AudioFrame]:
        transcript_parts: list[str] = []

        async def text_with_transcript() -> AsyncIterable[str]:
            async for chunk in text:
                chunk_text = str(chunk)
                if chunk_text:
                    transcript_parts.append(chunk_text)
                    with contextlib.suppress(Exception):
                        await self._publish_assistant_transcript(chunk_text, False)
                yield chunk

        try:
            async for frame in Agent.default.tts_node(self, text_with_transcript(), model_settings):
                await self._avatar_ws.send_audio_frame(frame)
                yield frame
        except asyncio.CancelledError:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self._avatar_ws.interrupt(), timeout=0.5)
            raise
        finally:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self._avatar_ws.finish_speaking(), timeout=1)
            final_text = "".join(transcript_parts).strip()
            if final_text:
                with contextlib.suppress(Exception):
                    await self._publish_assistant_transcript(final_text, True)
