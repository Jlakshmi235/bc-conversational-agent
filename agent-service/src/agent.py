from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterable, Awaitable, Callable

from livekit import rtc
from livekit.agents import Agent, ModelSettings, llm

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
        self._last_assistant_text = ""

    def llm_node(
        self,
        chat_ctx: llm.ChatContext,
        tools: list[llm.Tool],
        model_settings: ModelSettings,
    ):
        # LiveKit's provider context does not always include the preceding
        # assistant turn. Preserve it explicitly so the Worker can resolve a
        # bare "yes" or "no" against the question the educator just asked.
        # The proxy consumes and removes this hidden system marker before it
        # sends the request to Groq.
        augmented_ctx = chat_ctx.copy()
        if self._last_assistant_text:
            safe_previous_text = self._last_assistant_text.replace(
                "</previous_assistant_message>", ""
            )[-4_000:]
            augmented_ctx.add_message(
                role="system",
                content=(
                    "<previous_assistant_message>"
                    f"{safe_previous_text}"
                    "</previous_assistant_message>"
                ),
            )
        return Agent.default.llm_node(self, augmented_ctx, tools, model_settings)

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
                self._last_assistant_text = final_text
                with contextlib.suppress(Exception):
                    await self._publish_assistant_transcript(final_text, True)
