"""Test-only bridge proving both independent backends can use the same SQL data."""
import contextlib
import io
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from cloud.database import create_database, create_session_factory
from cloud.repository import Repository


request = json.load(sys.stdin)
if request["method"] in ("migrate", "schema_check"):
    from alembic import command
    from alembic.config import Config

    config = Config(str(ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(ROOT / "alembic"))
    config.stdout = io.StringIO()
    with contextlib.redirect_stdout(io.StringIO()):
        if request["method"] == "migrate":
            command.upgrade(config, "head")
        else:
            command.check(config)
    result = {"status": "ok"}
else:
    engine = create_database(os.environ["DATABASE_URL"])
    try:
        repository = Repository(create_session_factory(engine), request["principal"])
        result = getattr(repository, request["method"])(*request.get("args", []), **request.get("kwargs", {}))
    finally:
        engine.dispose()
json.dump(result, sys.stdout, ensure_ascii=False, allow_nan=False)
