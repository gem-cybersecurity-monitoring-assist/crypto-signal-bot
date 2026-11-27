"""Idempotent upgrade of the paper ledger schema (additive only).

``create_all`` does not alter existing tables, so databases created before the
atomic ledger columns existed are upgraded here. Legacy rows keep NULL evidence
columns; portfolio recovery treats them as ambiguous and fails closed.
"""
from __future__ import annotations

import sqlalchemy as sa

_TRADE_COLUMNS = {
    "fill_key": "VARCHAR(128)",
    "qty_text": "VARCHAR(64)",
    "price_text": "VARCHAR(64)",
    "fee_text": "VARCHAR(64)",
    "realized_pnl_text": "VARCHAR(64)",
    "cash_after_text": "VARCHAR(64)",
}
_FILL_KEY_INDEX = "ux_trades_account_fill_key"


def upgrade_paper_ledger_schema(conn) -> None:
    """Run on a synchronous connection (``run_sync`` or alembic bind)."""
    inspector = sa.inspect(conn)
    if "trades" not in inspector.get_table_names():
        return  # create_all will build the current schema
    existing = {c["name"] for c in inspector.get_columns("trades")}
    for name, ddl in _TRADE_COLUMNS.items():
        if name not in existing:
            conn.execute(sa.text(f"ALTER TABLE trades ADD COLUMN {name} {ddl}"))
    indexes = {i["name"] for i in sa.inspect(conn).get_indexes("trades")}
    if _FILL_KEY_INDEX not in indexes:
        conn.execute(sa.text(
            f"CREATE UNIQUE INDEX {_FILL_KEY_INDEX} ON trades (account_id, fill_key)"
        ))
