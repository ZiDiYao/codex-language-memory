"""One-time, account-bound upload of the legacy learning database.

SQLite is read only as a migration source. A frozen backup makes retries
identical; the receipt contains routing metadata, never notes or OAuth tokens.
"""

import fcntl
import hashlib
import json
import os
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path


TABLES = (
    "knowledge", "settings", "capture_preferences", "encounters", "review_events",
    "memory_states", "learner_preferences", "export_receipts", "study_sessions",
    "study_items", "study_answers",
)
MAX_BYTES = 8 * 1024 * 1024


class MigrationError(ValueError):
    def __init__(self, code="cloud_import_unavailable"):
        self.code = code
        super().__init__(code)


class DesktopMigration:
    def __init__(self, database: Path):
        self.database = Path(database).expanduser().resolve()
        namespace = hashlib.sha256(os.fsencode(self.database)).hexdigest()[:20]
        self.receipt = self.database.with_name("desktop-cloud-import-" + namespace + ".json")
        self._lock = threading.Lock()

    @contextmanager
    def _locked(self):
        self.receipt.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(self.receipt.with_suffix(".lock"), os.O_CREAT | os.O_RDWR, 0o600)
        try:
            os.fchmod(descriptor, 0o600)
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            os.close(descriptor)

    def _read(self):
        if not self.receipt.exists():
            return None
        try:
            value = json.loads(self.receipt.read_text())
            if (value["version"] != 1 or value["status"] not in ("pending", "complete")
                    or str(uuid.UUID(value["source_id"])) != value["source_id"]
                    or len(value["target"]) != 64 or len(value["snapshot_sha"]) != 64):
                raise ValueError()
            return value
        except (OSError, ValueError, KeyError, TypeError):
            raise MigrationError() from None

    def _write(self, value):
        temporary = self.receipt.with_name(self.receipt.name + "." + uuid.uuid4().hex + ".tmp")
        try:
            with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as file:
                json.dump(value, file, sort_keys=True)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, self.receipt)
        finally:
            temporary.unlink(missing_ok=True)

    def _backup_path(self, source_id):
        return self.database.parent / "backups" / ("cloud-import-" + str(uuid.UUID(source_id)) + ".sqlite3")

    def _freeze(self, source_id):
        backup = self._backup_path(source_id)
        backup.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(descriptor)
        try:
            with sqlite3.connect(self.database.resolve().as_uri() + "?mode=ro", uri=True) as source:
                with sqlite3.connect(backup) as destination:
                    source.backup(destination)
        except Exception:
            backup.unlink(missing_ok=True)
            raise
        return backup

    @staticmethod
    def _snapshot(database, source_id):
        tables = {}
        with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True) as connection:
            connection.row_factory = sqlite3.Row
            connection.execute("BEGIN")
            available = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            for table in TABLES:
                # Table names come only from this fixed whitelist, never the file.
                tables[table] = ([dict(row) for row in connection.execute(f'SELECT * FROM "{table}" ORDER BY 1')]
                                 if table in available else [])
        payload = {"schema_version": 1, "source_id": source_id, "tables": tables}
        encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
        if len(encoded) > MAX_BYTES:
            raise MigrationError("cloud_import_too_large")
        return payload, hashlib.sha256(encoded).hexdigest()

    def capture_ready(self):
        """A short automatic capture must not start a potentially long import."""
        if not self.database.exists() and not self.receipt.exists():
            return True
        receipt = self._read()
        return bool(receipt and receipt["status"] == "complete")

    def ensure(self, account, *, expected_epoch):
        if not self.database.exists() and not self.receipt.exists():
            return  # New installation: all learning data starts in the cloud.
        with self._lock, self._locked():
            try:
                receipt = self._read()
                if receipt and receipt["status"] == "complete":
                    return  # Never import the old backup into a later account.
                target = account.account_fingerprint(expected_epoch=expected_epoch)
                if receipt:
                    if receipt["target"] != target:
                        raise MigrationError("cloud_import_account_mismatch")
                    payload, digest = self._snapshot(self._backup_path(receipt["source_id"]), receipt["source_id"])
                    if digest != receipt["snapshot_sha"]:
                        raise MigrationError()
                else:
                    source_id = str(uuid.uuid4())
                    payload, digest = self._snapshot(self._freeze(source_id), source_id)
                    receipt = {"version": 1, "source_id": source_id, "status": "pending",
                               "target": target, "snapshot_sha": digest}
                    self._write(receipt)
                result = account.request_api("POST", "/v1/desktop-imports", json=payload, expected_epoch=expected_epoch)
                if (not isinstance(result, dict) or result.get("status") not in ("imported", "already_imported")
                        or result.get("source_id") != receipt["source_id"]):
                    raise MigrationError()
                if account.account_fingerprint(expected_epoch=expected_epoch) != target:
                    raise MigrationError("account_changed")
                returned_counts = result.get("counts", {})
                counts = ({table: count for table, count in returned_counts.items()
                           if table in TABLES and type(count) is int and count >= 0}
                          if isinstance(returned_counts, dict) else {})
                self._write({**receipt, "status": "complete", "counts": counts})
            except (sqlite3.Error, OSError, TypeError, KeyError):
                raise MigrationError() from None
