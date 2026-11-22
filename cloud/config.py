"""Fail-closed deployment configuration for the remote resource server."""

from dataclasses import dataclass
import ipaddress
import os
from urllib.parse import urlsplit


def _url(value: str, name: str, allow_local: bool) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} is required")
    value = value.strip()
    parsed = urlsplit(value)
    if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError(f"{name} must be an absolute URL without credentials, query or fragment")
    local = parsed.hostname.lower() == "localhost"
    try:
        local = local or ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        pass
    if parsed.scheme != "https" and not (allow_local and local and parsed.scheme == "http"):
        raise ValueError(f"{name} requires HTTPS; HTTP is only available for explicit loopback development")
    return value


@dataclass(frozen=True)
class CloudSettings:
    database_url: str
    public_url: str
    auth_issuer: str
    auth_audience: str
    auth_jwks_url: str
    required_scopes: tuple[str, ...] = ("memory:read", "memory:write")
    allow_insecure_local: bool = False
    host: str = "0.0.0.0"
    port: int = 8080

    def __post_init__(self):
        if not isinstance(self.database_url, str) or not self.database_url:
            raise ValueError("DATABASE_URL is required")
        if not self.database_url.startswith(("postgres://", "postgresql://", "postgresql+psycopg://")):
            if not (self.allow_insecure_local and self.database_url.startswith("sqlite")):
                raise ValueError("DATABASE_URL must use PostgreSQL in production")
        for field, env_name in (("public_url", "PUBLIC_URL"), ("auth_issuer", "AUTH_ISSUER"), ("auth_jwks_url", "AUTH_JWKS_URL")):
            object.__setattr__(self, field, _url(getattr(self, field), env_name, self.allow_insecure_local))
        if urlsplit(self.public_url).path not in ("", "/"):
            raise ValueError("PUBLIC_URL must be the service root URL")
        object.__setattr__(self, "public_url", self.public_url.rstrip("/"))
        if not isinstance(self.auth_audience, str) or not self.auth_audience.strip():
            raise ValueError("AUTH_AUDIENCE is required")
        if not self.required_scopes or any(not isinstance(scope, str) or not scope or any(c.isspace() for c in scope) for scope in self.required_scopes):
            raise ValueError("AUTH_REQUIRED_SCOPES must contain at least one scope")
        object.__setattr__(self, "required_scopes", tuple(dict.fromkeys(self.required_scopes)))
        if type(self.port) is not int or not 1 <= self.port <= 65535:
            raise ValueError("PORT must be between 1 and 65535")

    @property
    def resource_url(self) -> str:
        return self.public_url + "/mcp"

    @classmethod
    def from_env(cls, environ=None):
        environ = os.environ if environ is None else environ
        required = ("DATABASE_URL", "PUBLIC_URL", "AUTH_ISSUER", "AUTH_AUDIENCE", "AUTH_JWKS_URL")
        missing = [name for name in required if not environ.get(name)]
        if missing:
            raise ValueError("Missing required configuration: " + ", ".join(missing))
        insecure = environ.get("CLOUD_ALLOW_INSECURE_LOCAL", "false").lower()
        if insecure not in ("true", "false"):
            raise ValueError("CLOUD_ALLOW_INSECURE_LOCAL must be true or false")
        try:
            port = int(environ.get("PORT", "8080"))
        except ValueError as error:
            raise ValueError("PORT must be an integer") from error
        return cls(
            database_url=environ["DATABASE_URL"], public_url=environ["PUBLIC_URL"],
            auth_issuer=environ["AUTH_ISSUER"], auth_audience=environ["AUTH_AUDIENCE"],
            auth_jwks_url=environ["AUTH_JWKS_URL"],
            required_scopes=tuple(environ.get("AUTH_REQUIRED_SCOPES", "memory:read memory:write").split()),
            allow_insecure_local=insecure == "true", host=environ.get("HOST", "0.0.0.0"), port=port,
        )
