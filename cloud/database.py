"""SQLAlchemy engine setup. Production data lives in PostgreSQL."""

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


SCHEMA_REVISION = "0001_remote_storage"


def create_database(url: str, *, allow_sqlite: bool = False) -> Engine:
    if url.startswith("postgres://"):
        url = "postgresql+psycopg://" + url[len("postgres://"):]
    elif url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    parsed = make_url(url)
    if parsed.get_backend_name() == "sqlite":
        if not allow_sqlite:
            raise ValueError("The cloud service requires PostgreSQL; SQLite is a test adapter only")
        options = {"connect_args": {"check_same_thread": False, "timeout": 30}}
        if parsed.database in {None, "", ":memory:"}:
            options["poolclass"] = StaticPool
        engine = create_engine(parsed, hide_parameters=True, **options)

        @event.listens_for(engine, "connect")
        def configure_sqlite(connection, _):
            connection.execute("PRAGMA foreign_keys = ON")

        return engine
    if parsed.get_backend_name() != "postgresql":
        raise ValueError("The cloud service requires PostgreSQL")
    return create_engine(parsed, pool_pre_ping=True, hide_parameters=True)


def create_session_factory(engine_or_url, *, allow_sqlite: bool = False):
    engine = (create_database(engine_or_url, allow_sqlite=allow_sqlite)
              if isinstance(engine_or_url, str) else engine_or_url)
    return sessionmaker(bind=engine, expire_on_commit=False)
