"""Database lifecycle regression tests; no external database connections."""
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import text

from backend.db import session as db


@pytest.fixture
def isolated_db(monkeypatch, tmp_path):
    monkeypatch.setattr(db, "_engine", None)
    monkeypatch.setattr(db, "_session_factory", None)
    cfg = SimpleNamespace(url=f"sqlite:///{tmp_path / 'lifecycle.db'}",
                          echo=False, pool_size=1, max_overflow=0)
    monkeypatch.setattr(db, "get_database_config", lambda: cfg)


@pytest.mark.asyncio
async def test_repeated_start_close_and_restart(isolated_db):
    try:
        await db.init_db()
        first_engine = db._engine
        first_factory = db._session_factory
        await db.init_db()
        assert db._engine is first_engine
        assert db._session_factory is first_factory
        async with db.get_session() as session:
            assert (await session.execute(text("SELECT 1"))).scalar_one() == 1
        await db.close_db()
        await db.close_db()
        assert db._engine is None
        assert db._session_factory is None
        with pytest.raises(RuntimeError, match="not initialised"):
            async with db.get_session():
                pytest.fail("closed database supplied a session")
        await db.init_db()
        assert db._engine is not first_engine
        async with db.get_session() as session:
            assert (await session.execute(text("SELECT 1"))).scalar_one() == 1
    finally:
        await db.close_db()


@pytest.mark.asyncio
async def test_failed_initialization_never_publishes_factory(isolated_db, monkeypatch):
    engine = MagicMock()
    engine.dispose = AsyncMock()
    connection = AsyncMock()
    connection.run_sync.side_effect = RuntimeError("schema failure")
    engine.begin.return_value.__aenter__ = AsyncMock(return_value=connection)
    engine.begin.return_value.__aexit__ = AsyncMock(return_value=False)
    monkeypatch.setattr(db, "create_async_engine", lambda *a, **kw: engine)
    monkeypatch.setattr(db, "async_sessionmaker", MagicMock(return_value=object()))
    with pytest.raises(RuntimeError, match="schema failure"):
        await db.init_db()
    engine.dispose.assert_awaited_once()
    assert db._engine is None
    assert db._session_factory is None
    with pytest.raises(RuntimeError, match="not initialised"):
        async with db.get_session():
            pytest.fail("failed database supplied a session")


@pytest.mark.asyncio
async def test_factory_unavailable_while_disposing(isolated_db, monkeypatch):
    engine = MagicMock()

    async def dispose():
        assert db._engine is None
        assert db._session_factory is None
        with pytest.raises(RuntimeError, match="not initialised"):
            async with db.get_session():
                pytest.fail("disposing database supplied a session")

    engine.dispose = AsyncMock(side_effect=dispose)
    monkeypatch.setattr(db, "_engine", engine)
    monkeypatch.setattr(db, "_session_factory", MagicMock())
    await db.close_db()
    engine.dispose.assert_awaited_once()
