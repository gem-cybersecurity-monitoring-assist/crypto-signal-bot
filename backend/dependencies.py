"""Shared API dependencies for FastAPI routes."""
from hmac import compare_digest

from fastapi import Depends, HTTPException, Security
from fastapi.security.api_key import APIKeyHeader

from backend.config.runtime import get_runtime_config

_api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def get_backend_api_key() -> str:
    return get_runtime_config().backend_api_key


def require_auth(
    api_key: str | None = Security(_api_key_header),
    configured_key: str = Depends(get_backend_api_key),
) -> None:
    if configured_key and (
        api_key is None or not compare_digest(api_key.encode(), configured_key.encode())
    ):
        raise HTTPException(status_code=401, detail="Invalid or missing API key")
