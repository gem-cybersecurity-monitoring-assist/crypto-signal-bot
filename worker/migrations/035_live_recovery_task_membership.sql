-- One immutable accounting intent per fill may belong to several snapshots.
CREATE TABLE IF NOT EXISTS live_recovery_task_memberships (
  ingestion_id TEXT NOT NULL REFERENCES live_recovery_ingestions(ingestion_id),
  task_intent_id TEXT NOT NULL REFERENCES live_recovery_accounting_task_intents(task_intent_id),
  PRIMARY KEY (ingestion_id, task_intent_id)
);
INSERT OR IGNORE INTO live_recovery_task_memberships (ingestion_id, task_intent_id)
  SELECT ingestion_id, task_intent_id FROM live_recovery_accounting_task_intents;
CREATE TRIGGER IF NOT EXISTS live_recovery_task_memberships_no_update
BEFORE UPDATE ON live_recovery_task_memberships BEGIN
  SELECT RAISE(ABORT, 'recovery task membership is immutable');
END;
CREATE TRIGGER IF NOT EXISTS live_recovery_task_memberships_no_delete
BEFORE DELETE ON live_recovery_task_memberships BEGIN
  SELECT RAISE(ABORT, 'recovery task membership is immutable');
END;
