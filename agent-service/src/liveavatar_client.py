from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Self

import httpx


@dataclass
class StartedSession:
    session_id: str
    session_token: str
    livekit_url: str
    livekit_agent_token: str
    livekit_client_token: str
    ws_url: str
    max_session_duration: int


class LiveAvatarClient:
    def __init__(self, api_key: str, base_url: str = "https://api.liveavatar.com") -> None:
        self._http = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            timeout=30,
            headers={"X-API-KEY": api_key},
        )

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self._http.aclose()

    async def start_lite_session(
        self,
        *,
        avatar_id: str,
        is_sandbox: bool,
        max_session_duration: int,
    ) -> StartedSession:
        token_body: dict[str, Any] = {
            "mode": "LITE",
            "avatar_id": avatar_id,
            "is_sandbox": is_sandbox,
            "max_session_duration": max_session_duration,
            "video_settings": {"quality": "high", "encoding": "H264"},
        }
        token_response = await self._http.post("/v1/sessions/token", json=token_body)
        if token_response.is_error:
            raise RuntimeError(
                f"LiveAvatar token request failed ({token_response.status_code}): "
                f"{token_response.text}"
            )
        token_data = token_response.json().get("data") or {}
        session_token = token_data.get("session_token")
        if not session_token:
            raise RuntimeError("LiveAvatar did not return a session token.")

        start_response = await self._http.post(
            "/v1/sessions/start",
            headers={"Authorization": f"Bearer {session_token}"},
            json={},
        )
        if start_response.is_error:
            raise RuntimeError(
                f"LiveAvatar start request failed ({start_response.status_code}): "
                f"{start_response.text}"
            )
        data = start_response.json().get("data") or {}
        required = ["session_id", "livekit_url", "livekit_agent_token", "livekit_client_token", "ws_url"]
        missing = [key for key in required if not data.get(key)]
        if missing:
            raise RuntimeError(f"LiveAvatar start response is missing: {', '.join(missing)}")

        return StartedSession(
            session_id=data["session_id"],
            session_token=session_token,
            livekit_url=data["livekit_url"],
            livekit_agent_token=data["livekit_agent_token"],
            livekit_client_token=data["livekit_client_token"],
            ws_url=data["ws_url"],
            max_session_duration=int(data.get("max_session_duration") or max_session_duration),
        )

    async def stop_session(
        self,
        session_token: str,
        reason: str = "USER_CLOSED",
    ) -> None:
        response = await self._http.post(
            "/v1/sessions/stop",
            headers={"Authorization": f"Bearer {session_token}"},
            json={"reason": reason},
        )
        if response.is_error and response.status_code != 404:
            raise RuntimeError(
                f"LiveAvatar stop request failed ({response.status_code}): {response.text}"
            )
