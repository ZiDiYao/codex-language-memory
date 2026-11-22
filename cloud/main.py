"""Production entry point; migrations run separately before starting the service."""

from cloud.app import create_app, database_readiness
from cloud.config import CloudSettings
from cloud.database import create_database, create_session_factory
from cloud.repository import Repository


settings = CloudSettings.from_env()
try:
    engine = create_database(settings.database_url, allow_sqlite=settings.allow_insecure_local)
except Exception:
    raise RuntimeError("Invalid DATABASE_URL configuration") from None
session_factory = create_session_factory(engine)


def ready():
    return database_readiness(engine)


app = create_app(settings, lambda principal: Repository(session_factory, principal), readiness=ready)


if __name__ == "__main__":
    import uvicorn

    # Access logs include search query strings; keep learning content out of logs.
    uvicorn.run(app, host=settings.host, port=settings.port, workers=1, access_log=False)
