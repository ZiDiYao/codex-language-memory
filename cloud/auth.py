"""External OIDC access-token verification; this service does not issue tokens."""

from dataclasses import dataclass
import time

import jwt
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import AccessToken, TokenVerifier
from starlette.concurrency import run_in_threadpool

from cloud.config import CloudSettings


ALGORITHMS = ("RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "EdDSA")


@dataclass(frozen=True)
class Principal:
    issuer: str
    subject: str


class AuthenticationError(Exception):
    def __init__(self, status_code=401, code="invalid_token"):
        self.status_code = status_code
        self.code = code
        super().__init__(code)


class JWTVerifier(TokenVerifier):
    """Validate signed JWTs against one configured issuer, audience and JWKS URL."""

    def __init__(self, settings: CloudSettings, *, jwks_client=None):
        self.settings = settings
        self.jwks = jwks_client or jwt.PyJWKClient(
            settings.auth_jwks_url, cache_jwk_set=True, lifespan=300, timeout=5,
        )

    async def verify_token(self, token: str) -> AccessToken | None:
        # JWKS retrieval and signature verification must never block the ASGI loop.
        return await run_in_threadpool(self._verify, token)

    def _verify(self, token):
        if not isinstance(token, str) or not token or len(token) > 16384:
            return None
        try:
            header = jwt.get_unverified_header(token)
            if header.get("alg") not in ALGORITHMS:
                return None
            kid = header.get("kid")
            if not isinstance(kid, str) or not kid or len(kid) > 256:
                return None
            # Ignore token-controlled jku/x5u URLs: keys come only from configured JWKS.
            key = self.jwks.get_signing_key_from_jwt(token)
            claims = jwt.decode(
                token, key.key, algorithms=[header["alg"]],
                issuer=self.settings.auth_issuer, audience=self.settings.auth_audience,
                options={"require": ["iss", "sub", "aud", "exp"]},
            )
            subject = claims.get("sub")
            expires = claims.get("exp")
            if not isinstance(subject, str) or not subject or len(subject) > 512:
                return None
            if isinstance(expires, bool) or not isinstance(expires, (int, float)) or expires <= time.time():
                return None
            scope = claims.get("scope", claims.get("scp", []))
            if isinstance(scope, str):
                scopes = scope.split()
            elif isinstance(scope, list) and all(isinstance(item, str) and item for item in scope):
                scopes = scope
            else:
                return None
            return AccessToken(
                token=token, client_id=str(claims.get("azp") or claims.get("client_id") or subject),
                subject=subject, scopes=list(dict.fromkeys(scopes)), expires_at=int(expires),
                resource=self.settings.resource_url, claims={"iss": claims["iss"], "sub": subject},
            )
        except (jwt.PyJWTError, ValueError, TypeError, OverflowError, OSError):
            # Fail closed without logging tokens, claims, signatures or JWKS response bodies.
            return None


def current_principal(settings: CloudSettings) -> Principal:
    token = get_access_token()
    if token is None:
        raise AuthenticationError()
    if any(scope not in token.scopes for scope in settings.required_scopes):
        raise AuthenticationError(403, "insufficient_scope")
    claims = token.claims or {}
    if claims.get("iss") != settings.auth_issuer or not token.subject:
        raise AuthenticationError()
    return Principal(issuer=settings.auth_issuer, subject=token.subject)
