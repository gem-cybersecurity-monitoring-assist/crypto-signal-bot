-- Local replay candidate only. Not a production migration.
CREATE TABLE IF NOT EXISTS isolated_replay_portfolio_events (
  portfolio_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  event_hash TEXT NOT NULL CHECK(length(event_hash) = 64),
  event_type TEXT NOT NULL CHECK(event_type IN ('replay_fill','replay_halted')),
  event_json TEXT NOT NULL CHECK(length(event_json) <= 65536),
  book_value TEXT NOT NULL,
  PRIMARY KEY(portfolio_id,version)
);
CREATE TRIGGER IF NOT EXISTS isolated_replay_events_no_update
BEFORE UPDATE ON isolated_replay_portfolio_events
BEGIN SELECT RAISE(ABORT,'Replay projection is immutable'); END;
CREATE TRIGGER IF NOT EXISTS isolated_replay_events_no_delete
BEFORE DELETE ON isolated_replay_portfolio_events
BEGIN SELECT RAISE(ABORT,'Replay projection is immutable'); END;
