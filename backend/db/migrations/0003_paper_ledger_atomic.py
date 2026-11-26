"""Paper ledger atomic evidence columns

Revision ID: 0003_paper_ledger_atomic
Revises: 0002_broker_tables
Create Date: 2026-11-26

Adds exact-decimal fill evidence and a unique fill key to ``trades`` and
creates ``paper_account_state``. Additive; legacy rows stay NULL and are
rejected (fail closed) by portfolio recovery.
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0003_paper_ledger_atomic"
down_revision = "0002_broker_tables"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if "paper_account_state" not in sa.inspect(bind).get_table_names():
        op.create_table(
            "paper_account_state",
            sa.Column("account_id", sa.String(64), primary_key=True),
            sa.Column("cash_text", sa.String(64), nullable=False),
            sa.Column("peak_equity_text", sa.String(64), nullable=False),
            sa.Column("trade_counter", sa.Integer, nullable=False, server_default="0"),
            sa.Column("updated_at", sa.BigInteger, nullable=True),
        )
    # Freeze the revision's schema independently of later runtime helpers.
    inspector = sa.inspect(bind)
    if "trades" in inspector.get_table_names():
        columns = {c["name"] for c in inspector.get_columns("trades")}
        for name, size in (("fill_key", 128), ("qty_text", 64), ("price_text", 64),
                           ("fee_text", 64), ("realized_pnl_text", 64), ("cash_after_text", 64)):
            if name not in columns:
                op.add_column("trades", sa.Column(name, sa.String(size), nullable=True))
        indexes = {i["name"] for i in sa.inspect(bind).get_indexes("trades")}
        if "ux_trades_account_fill_key" not in indexes:
            op.create_index("ux_trades_account_fill_key", "trades",
                            ["account_id", "fill_key"], unique=True)


def downgrade() -> None:
    # Additive evidence is intentionally retained.
    pass
