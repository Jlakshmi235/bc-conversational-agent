from __future__ import annotations

import asyncio
import audioop
import base64
import contextlib
import json
import logging
import ssl
import uuid

import certifi
import websockets
from livekit import rtc
from websockets.exceptions import ConnectionClosed

logger = logging.getLogger("avatar_ws")

SAMPLE_RATE = 24_000
ONE_SECOND_BYTES = SAMPLE_RATE * 2
FIRST_CHUNK_BYTES = int(ONE_SECOND_BYTES * 0.4)


class AvatarWebSocket:
    def __init__(self, ws_url: str) -> None:
        self._url = ws_url
        self._ws = None
        self._connected = asyncio.Event()
        self._buffer = bytearray()
        self._speaking = False
        self._first_chunk = True
        self._event_id: str | None = None
        self._reader_task: asyncio.Task | None = None

    async def connect(self) -> None:
        # Python.org macOS installations may not inherit the system trust store.
        # Use certifi explicitly so TLS validation remains enabled.
        ssl_context = ssl.create_default_context(cafile=certifi.where())
        self._ws = await websockets.connect(
            self._url,
            ping_interval=None,
            ssl=ssl_context,
        )
        self._reader_task = asyncio.create_task(self._read_events())
        await asyncio.wait_for(self._connected.wait(), timeout=15)

    async def _read_events(self) -> None:
        assert self._ws is not None
        try:
            async for raw in self._ws:
                event = json.loads(raw)
                if event.get("type") == "session.state_updated" and event.get("state") == "connected":
                    self._connected.set()
                logger.info("LiveAvatar event: %s", event)
        except (ConnectionClosed, json.JSONDecodeError) as error:
            logger.warning("LiveAvatar WebSocket reader stopped: %s", error)

    async def _send(self, payload: dict) -> None:
        if not self._connected.is_set() or self._ws is None:
            raise RuntimeError("LiveAvatar WebSocket is not connected.")
        await self._ws.send(json.dumps(payload))

    async def send_audio_frame(self, frame: rtc.AudioFrame) -> None:
        if not self._speaking:
            self._speaking = True
            self._first_chunk = True
            self._event_id = str(uuid.uuid4())

        raw = frame.data.tobytes() if hasattr(frame.data, "tobytes") else bytes(frame.data)
        if frame.sample_rate != SAMPLE_RATE:
            raw, _ = audioop.ratecv(raw, 2, frame.num_channels, frame.sample_rate, SAMPLE_RATE, None)
        if frame.num_channels == 2:
            raw = audioop.tomono(raw, 2, 0.5, 0.5)

        self._buffer.extend(raw)
        target = FIRST_CHUNK_BYTES if self._first_chunk else ONE_SECOND_BYTES
        while len(self._buffer) >= target:
            chunk = bytes(self._buffer[:target])
            del self._buffer[:target]
            await self._send(
                {
                    "type": "agent.speak",
                    "event_id": self._event_id,
                    "audio": base64.b64encode(chunk).decode("ascii"),
                }
            )
            self._first_chunk = False
            target = ONE_SECOND_BYTES

    async def finish_speaking(self) -> None:
        if not self._speaking:
            return
        if self._buffer:
            await self._send(
                {
                    "type": "agent.speak",
                    "event_id": self._event_id,
                    "audio": base64.b64encode(bytes(self._buffer)).decode("ascii"),
                }
            )
            self._buffer.clear()
        await self._send({"type": "agent.speak_end", "event_id": self._event_id})
        self._speaking = False
        self._event_id = None

    async def interrupt(self) -> None:
        self._buffer.clear()
        self._speaking = False
        await self._send({"type": "agent.interrupt", "event_id": self._event_id})
        self._event_id = None

    async def close(self) -> None:
        if self._reader_task:
            self._reader_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._reader_task
        if self._ws:
            await self._ws.close()
        self._ws = None
