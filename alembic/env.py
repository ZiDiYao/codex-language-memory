"""Explicit deployment migrations; application startup never creates tables."""

import os

from alembic import context

from cloud.database import create_database
from cloud.models import Base


config = context.config
url = os.environ.get("DATABASE_URL") or config.get_main_option("sqlalchemy.url")
if not url:
    raise RuntimeError("Set DATABASE_URL before running database migrations")
engine = create_database(url)

if context.is_offline_mode():
    context.configure(url=engine.url, target_metadata=Base.metadata, literal_binds=True,
                      dialect_opts={"paramstyle": "named"}, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=Base.metadata, compare_type=True)
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()
