"""Desktop OAuth account boundary. Secrets live only in the macOS Keychain.

The small state file contains mode/epoch only. It coordinates independent MCP
processes; it is deliberately separate from the learner's SQLite database.
"""
from __future__ import annotations

import asyncio
import base64
from concurrent.futures import TimeoutError as FutureTimeout
from contextlib import contextmanager, asynccontextmanager
import contextvars
from datetime import timedelta
import fcntl
import hashlib
import json
import logging
import os
from pathlib import Path
import secrets
import tempfile
import threading
import time
from urllib.parse import parse_qs, urlsplit

import httpx
from mcp import ClientSession
from mcp.client.auth.oauth2 import OAuthClientProvider
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.auth import OAuthClientInformationFull, OAuthClientMetadata, OAuthMetadata, OAuthToken

ISSUER = "https://language-memory.ca.auth0.com/"
API_ORIGIN = "https://language-memory-api.up.railway.app"
RESOURCE = API_ORIGIN + "/mcp"
SCOPES = "memory:read memory:write offline_access"
AUTHORIZE = ISSUER + "authorize"
TOKEN = ISSUER + "oauth/token"
REGISTER = ISSUER + "oidc/register"
REVOKE = ISSUER + "oauth/revoke"
PRM = API_ORIGIN + "/.well-known/oauth-protected-resource/mcp"
DISCOVERY = ISSUER + ".well-known/openid-configuration"
_account_context = contextvars.ContextVar("sayrove_account_context", default=False)


class AccountError(ValueError):
    """Only a stable, non-sensitive error code may cross the desktop boundary."""
    def __init__(self, code="cloud_unavailable"):
        self.code = code
        super().__init__(code)


class _QuietOAuth(logging.Filter):
    def filter(self, record):
        # SDK exceptions can include token endpoint bodies or OAuth state.
        return not _account_context.get()


for _sdk_logger in ("mcp.client.auth.oauth2", "mcp.client.streamable_http", "mcp.client.session", "httpx",
                    "httpcore.connection", "httpcore.http11", "httpcore.http2", "httpcore.proxy", "httpcore.socks"):
    logging.getLogger(_sdk_logger).addFilter(_QuietOAuth())


class _StateFile:
    def __init__(self, path):
        self.path = Path(path)

    @contextmanager
    def locked(self):
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        lock = self.path.with_suffix(self.path.suffix + ".lock")
        descriptor = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            os.fchmod(descriptor, 0o600)
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            if self.path.exists():
                try:
                    state = json.loads(self.path.read_text())
                    if (not isinstance(state, dict) or state.get("mode") not in ("local", "cloud")
                            or state.get("state") not in ("signed_out", "connecting", "connected", "error")
                            or type(state.get("epoch")) is not int or state["epoch"] < 0):
                        raise ValueError()
                except (ValueError, OSError):
                    raise AccountError("account_state_unavailable") from None
            else:
                state = {"mode": "local", "state": "connected", "epoch": 0}
            before = dict(state)
            yield state
            if state != before or not self.path.exists():
                fd, temporary = tempfile.mkstemp(prefix=".account-", dir=self.path.parent)
                try:
                    with os.fdopen(fd, "w") as output:
                        json.dump(state, output, sort_keys=True)
                        output.flush()
                        os.fsync(output.fileno())
                    os.replace(temporary, self.path)
                finally:
                    if os.path.exists(temporary):
                        os.unlink(temporary)
        finally:
            os.close(descriptor)

    def read(self):
        with self.locked() as state:
            return dict(state)

    @asynccontextmanager
    async def operation(self, timeout):
        descriptor = os.open(self.path.with_suffix(".operation.lock"), os.O_CREAT | os.O_RDWR, 0o600)
        deadline = time.monotonic() + timeout
        try:
            os.fchmod(descriptor, 0o600)
            while True:
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise AccountError("account_busy") from None
                    await asyncio.sleep(0.05)
            yield
        finally:
            os.close(descriptor)


class KeychainCredentials:
    """JSON credential envelope in a single OS Keychain item, never a file.

    An explicit backend is for isolated tests. Production accepts only the native
    macOS backend, and never keyrings.alt/plaintext or an automatic fallback.
    """
    def __init__(self, backend=None, *, service="Sayrove Desktop OAuth", account="language-memory-cloud"):
        self._backend = backend
        self.service, self.account = service, account

    def _keyring(self):
        if self._backend is None:
            try:
                from keyring.backends.macOS import Keyring
                self._backend = Keyring()
                if self._backend.priority <= 0:
                    raise ValueError()
            except Exception:
                raise AccountError("credential_store_unavailable") from None
        return self._backend

    def read(self):
        try:
            value = self._keyring().get_password(self.service, self.account)
            result = json.loads(value) if value else {}
            if not isinstance(result, dict):
                raise ValueError()
            return result
        except Exception:
            raise AccountError("credential_store_unavailable") from None

    def write(self, value):
        try:
            self._keyring().set_password(self.service, self.account, json.dumps(value, separators=(",", ":")))
        except Exception:
            raise AccountError("credential_store_unavailable") from None

    def clear(self):
        try:
            backend = self._keyring()
            if backend.get_password(self.service, self.account) is not None:
                backend.delete_password(self.service, self.account)
        except Exception:
            raise AccountError("credential_store_unavailable") from None


def _token_identity(tokens):
    # This is an account-consistency check, never a substitute for the resource
    # server's signature/audience/scope validation.
    try:
        payload = tokens.access_token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        audience = claims.get("aud")
        if (claims.get("iss") != ISSUER or not isinstance(claims.get("sub"), str) or not claims["sub"]
                or RESOURCE not in ([audience] if isinstance(audience, str) else audience or [])
                or not isinstance(claims.get("exp"), (int, float))):
            raise ValueError()
        return hashlib.sha256((ISSUER + "\0" + claims["sub"]).encode()).hexdigest(), claims["exp"]
    except Exception:
        raise AccountError("authentication_required") from None


class KeychainTokenStorage:
    """SDK TokenStorage implementation bound to one cross-process account epoch."""
    def __init__(self, credentials, state, epoch):
        self.credentials, self.state, self.epoch = credentials, state, epoch
        self.expires_at = 0.0

    @contextmanager
    def _envelope(self):
        with self.state.locked() as state:
            if state["epoch"] != self.epoch or state["mode"] != "cloud":
                raise AccountError("account_changed")
            value = self.credentials.read()
            if value.get("epoch") != self.epoch:
                value = {"epoch": self.epoch}
            yield value

    async def get_tokens(self):
        with self._envelope() as value:
            self.expires_at = value.get("expires_at", 0.0)
            raw = value.get("tokens")
            return OAuthToken.model_validate(raw) if raw else None

    async def set_tokens(self, tokens):
        with self._envelope() as value:
            identity, jwt_expiry = _token_identity(tokens)
            if value.get("identity") and value["identity"] != identity:
                raise AccountError("account_changed")
            if tokens.scope and not {"memory:read", "memory:write"}.issubset(tokens.scope.split()):
                raise AccountError("authentication_required")
            # Some providers omit the refresh token when reusing an existing one.
            if not tokens.refresh_token and value.get("tokens", {}).get("refresh_token"):
                tokens = tokens.model_copy(update={"refresh_token": value["tokens"]["refresh_token"]})
            self.expires_at = min(jwt_expiry, time.time() + tokens.expires_in) if tokens.expires_in is not None else jwt_expiry
            value.update(tokens=tokens.model_dump(mode="json"), identity=identity, expires_at=self.expires_at)
            self.credentials.write(value)

    async def get_client_info(self):
        with self._envelope() as value:
            raw = value.get("client")
            if not raw:
                return None
            result = OAuthClientInformationFull.model_validate(raw)
            if result.issuer != ISSUER or result.token_endpoint_auth_method != "none":
                raise AccountError("authentication_required")
            return result

    async def set_client_info(self, client_info):
        if client_info.issuer != ISSUER or client_info.token_endpoint_auth_method != "none":
            raise AccountError("authentication_required")
        with self._envelope() as value:
            value["client"] = client_info.model_dump(mode="json")
            self.credentials.write(value)


class _Provider(OAuthClientProvider):
    def __init__(self, *, interactive, epoch_check=lambda: None, **kwargs):
        super().__init__(**kwargs)
        self.interactive = interactive
        self.epoch_check = epoch_check

    def _expected_issuer(self):
        return ISSUER

    def _select_authorization_server(self, advertised):
        if advertised != [ISSUER]:
            raise AccountError("oauth_configuration_invalid")
        return ISSUER

    async def _validate_resource_match(self, prm):
        if str(prm.resource) != RESOURCE or [str(x) for x in prm.authorization_servers] != [ISSUER]:
            raise AccountError("oauth_configuration_invalid")

    def validate_metadata(self):
        metadata = self.context.oauth_metadata
        if (metadata is None or str(metadata.issuer) != ISSUER
                or str(metadata.authorization_endpoint) != AUTHORIZE or str(metadata.token_endpoint) != TOKEN
                or str(metadata.registration_endpoint) != REGISTER
                or "S256" not in (metadata.code_challenge_methods_supported or [])):
            raise AccountError("oauth_configuration_invalid")

    async def _initialize(self):
        await super()._initialize()
        self.context.token_expiry_time = self.context.storage.expires_at - 30

    async def _perform_authorization(self):
        if not self.interactive:
            raise AccountError("authentication_required")
        self.validate_metadata()
        self.context.client_metadata.scope = SCOPES
        return await super()._perform_authorization()

    async def _refresh_token(self):
        self.validate_metadata()
        return await super()._refresh_token()

    async def _handle_refresh_response(self, response):
        if response.status_code != 200:
            raise AccountError("authentication_required")
        # Avoid the SDK's exception logger (which can contain token bodies).
        try:
            token = OAuthToken.model_validate_json(await response.aread())
            await self.context.storage.set_tokens(token)
            self.context.current_tokens = await self.context.storage.get_tokens()
            self.context.token_expiry_time = self.context.storage.expires_at - 30
            return True
        except AccountError:
            raise
        except Exception:
            raise AccountError("authentication_required") from None

    async def async_auth_flow(self, request):
        # Drive the SDK flow without its automatic OAuth redirects. Every network
        # destination is exact and token-bearing bodies can never follow a 307.
        flow = super()._auth_flow(request)
        try:
            outgoing = await flow.__anext__()
            while True:
                self.epoch_check()
                url = str(outgoing.url)
                metadata_urls = {PRM, API_ORIGIN + "/.well-known/oauth-protected-resource", DISCOVERY,
                                 ISSUER + ".well-known/oauth-authorization-server"}
                if outgoing is request:
                    if urlsplit(url).scheme != "https" or (url != RESOURCE and not url.startswith(API_ORIGIN + "/v1/")):
                        raise AccountError("unsupported_cloud_operation")
                elif url == REGISTER and outgoing.method == "POST":
                    if not self.interactive:
                        raise AccountError("authentication_required")
                    self.validate_metadata()
                    self.context.client_metadata.scope = SCOPES
                    registration = self.context.client_metadata.model_dump(mode="json", exclude_none=True)
                    # Auth0's previously verified native DCR flow needs this OIDC
                    # metadata field; SDK 1.30's model otherwise drops the extra.
                    registration["application_type"] = "native"
                    outgoing = httpx.Request("POST", REGISTER, json=registration)
                elif not ((outgoing.method == "GET" and url in metadata_urls)
                          or (outgoing.method == "POST" and url == TOKEN)):
                    raise AccountError("oauth_configuration_invalid")
                response = yield outgoing
                if 300 <= response.status_code < 400:
                    raise AccountError("oauth_configuration_invalid")
                outgoing = await flow.asend(response)
        except StopAsyncIteration:
            return
        finally:
            await flow.aclose()


class _Loopback:
    def __init__(self, timeout):
        self.timeout = timeout
        self.server = None
        self.future = None
        self.expected_state = None
        self.issuer_required = True

    async def start(self):
        self.future = asyncio.get_running_loop().create_future()
        self.server = await asyncio.start_server(self._handle, "127.0.0.1", 0, limit=8192)
        self.port = self.server.sockets[0].getsockname()[1]
        self.url = f"http://127.0.0.1:{self.port}/oauth/callback"
        return self.url

    async def _handle(self, reader, writer):
        status = 400
        try:
            raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
            lines = raw.decode("ascii").split("\r\n")
            method, target, protocol = lines[0].split(" ")
            headers = {}
            for line in lines[1:]:
                if not line:
                    continue
                key, value = line.split(":", 1)
                key = key.lower()
                if key in headers:
                    raise ValueError()
                headers[key] = value.strip()
            url = urlsplit(target)
            query = parse_qs(url.query, keep_blank_values=True)
            if (method != "GET" or protocol not in ("HTTP/1.0", "HTTP/1.1") or url.scheme or url.netloc
                    or url.path != "/oauth/callback" or url.fragment
                    or headers.get("host") != f"127.0.0.1:{self.port}"
                    or headers.get("origin") or any(len(values) != 1 for values in query.values())
                    or ("code" in query and "error" in query)
                    or not self.expected_state or not secrets.compare_digest(query.get("state", [""])[0], self.expected_state)
                    or (self.issuer_required and query.get("iss") != [ISSUER])
                    or ("iss" in query and query["iss"] != [ISSUER])):
                raise ValueError()
            if self.future.done():
                raise ValueError()
            if "error" in query:
                self.future.set_exception(AccountError("login_cancelled"))
            elif query.get("code", [""])[0] and len(query["code"][0]) <= 4096:
                self.future.set_result((query["code"][0], query["state"][0]))
            else:
                raise ValueError()
            status = 200
        except Exception:
            pass
        body = b"You can close this window and return to Sayrove." if status == 200 else b"Invalid callback. Return to Sayrove."
        writer.write(f"HTTP/1.1 {status} {'OK' if status == 200 else 'Bad Request'}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\nConnection: close\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body)
        try:
            await writer.drain()
        except (ConnectionError, OSError):
            pass
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, OSError):
                pass

    async def wait(self):
        return await asyncio.wait_for(self.future, self.timeout)

    async def close(self):
        if self.server:
            self.server.close()
            await self.server.wait_closed()
        if self.future and not self.future.done():
            self.future.cancel()


def _account_error(error):
    if isinstance(error, AccountError):
        return error
    for child in getattr(error, "exceptions", []):
        result = _account_error(child)
        if result.code != "cloud_unavailable":
            return result
    return AccountError("cloud_unavailable")


class AccountManager:
    def __init__(self, *, state_path=None, credentials=None, http_transport=None, login_timeout=300, request_timeout=30):
        self.state = _StateFile(state_path or Path.home() / "Library/Application Support/Codex Language Memory/account-state.json")
        # Separate profiles can have the same numeric epoch. Bind their Keychain
        # items to the canonical state path, so neither reads nor deletes another
        # profile's account while same-profile MCP processes still share refresh.
        namespace = hashlib.sha256(os.fsencode(self.state.path.resolve())).hexdigest()
        self.credentials = credentials or KeychainCredentials(account="language-memory-cloud:" + namespace)
        self.http_transport = http_transport
        self.login_timeout, self.request_timeout = login_timeout, request_timeout
        self._lock = threading.RLock()
        self._login_future = None
        self._authorization = None
        self._login_epoch = None
        self._loop = None
        self._thread = None
        self._closed = False
        self._revocations = set()
        self.state.read()

    def status(self):
        with self._lock:
            with self.state.locked() as stored:
                if stored["state"] == "connecting" and stored.get("login_deadline", 0) < time.time():
                    stored.update(state="error", error="login_timeout", epoch=stored["epoch"] + 1)
                    stored.pop("login_deadline", None)
                state = dict(stored)
            cloud = state["mode"] == "cloud"
            result = {key: state[key] for key in ("mode", "state", "epoch")}
            result["capabilities"] = {"export": not cloud, "speech": not cloud or state["state"] == "connected", "study": not cloud}
            if self._login_epoch == state["epoch"] and state["state"] == "connecting" and self._authorization:
                result["authorization_url"] = self._authorization
            if state.get("error"):
                result["error"] = state["error"]
            return result

    def _submit(self, coroutine):
        with self._lock:
            if self._closed:
                coroutine.close()
                raise AccountError("cloud_unavailable")
            if self._loop is None:
                ready = threading.Event()
                def run():
                    loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(loop)
                    self._loop = loop
                    ready.set()
                    try:
                        loop.run_forever()
                    finally:
                        loop.close()
                self._thread = threading.Thread(target=run, name="sayrove-account", daemon=True)
                self._thread.start()
                ready.wait()
            return asyncio.run_coroutine_threadsafe(coroutine, self._loop)

    def _assert_epoch(self, epoch):
        state = self.state.read()
        if state["epoch"] != epoch or state["mode"] != "cloud":
            raise AccountError("account_changed")

    def _change(self, mode, state):
        with self._lock:
            revoke = None
            with self.state.locked() as stored:
                if stored["mode"] == "cloud":
                    try:
                        old = self.credentials.read()
                        client, tokens = old.get("client", {}), old.get("tokens", {})
                        if (old.get("epoch") == stored["epoch"] and client.get("issuer") == ISSUER
                                and client.get("token_endpoint_auth_method") == "none"
                                and isinstance(client.get("client_id"), str) and client["client_id"]
                                and isinstance(tokens.get("refresh_token"), str) and tokens["refresh_token"]):
                            revoke = (tokens["refresh_token"], client["client_id"])
                    except AccountError:
                        pass
                stored.update(mode=mode, state=state, epoch=stored["epoch"] + 1)
                stored.pop("error", None)
                stored.pop("login_deadline", None)
                if state == "connecting":
                    stored["login_deadline"] = time.time() + self.login_timeout
                self._authorization = None
                self._login_epoch = None
                if self._login_future:
                    self._login_future.cancel()
                    self._login_future = None
                # Commit local invalidation before any optional revocation IO.
                try:
                    self.credentials.clear()
                except AccountError:
                    stored["error"] = "credential_store_unavailable"
                epoch = stored["epoch"]
            if revoke:
                coroutine = self._revoke(*revoke)
                try:
                    future = self._submit(coroutine)
                except (AccountError, RuntimeError):
                    coroutine.close()
                else:
                    self._revocations.add(future)
                    future.add_done_callback(self._revocations.discard)
            return epoch

    async def _revoke(self, refresh_token, client_id):
        """Best effort only; never restore local authorization after failure."""
        context = _account_context.set(True)
        try:
            async with asyncio.timeout(5):
                async with httpx.AsyncClient(transport=self.http_transport, timeout=5, follow_redirects=False,
                                             trust_env=False) as client:
                    discovery = await client.get(DISCOVERY)
                    if discovery.status_code != 200:
                        return
                    metadata = discovery.json()
                    if metadata.get("issuer") != ISSUER or metadata.get("revocation_endpoint") != REVOKE:
                        return
                    # No access token, client secret, account id or SSO logout.
                    await client.post(REVOKE, data={"token": refresh_token, "client_id": client_id,
                                                   "token_type_hint": "refresh_token"})
        except Exception:
            pass
        finally:
            _account_context.reset(context)

    def disconnect(self):
        self._change("cloud", "signed_out")
        return self.status()

    def use_local(self):
        self._change("local", "connected")
        return self.status()

    def begin_login(self):
        with self._lock:
            current = self.state.read()
            if (self._login_future and not self._login_future.done() and current["epoch"] == self._login_epoch):
                return self.status()
            epoch = self._change("cloud", "connecting")
            self._login_epoch = epoch
            self._login_future = self._submit(self._login(epoch))
        return self.status()

    async def _provider(self, epoch, *, callback=None):
        storage = KeychainTokenStorage(self.credentials, self.state, epoch)
        old_client = await storage.get_client_info() if callback is None else None
        redirect = await callback.start() if callback else str(old_client.redirect_uris[0]) if old_client and old_client.redirect_uris else "http://127.0.0.1:1/oauth/callback"
        metadata = OAuthClientMetadata(redirect_uris=[redirect], token_endpoint_auth_method="none",
                                      grant_types=["authorization_code", "refresh_token"], response_types=["code"],
                                      scope=SCOPES, client_name="Sayrove Desktop")
        async def redirect_handler(url):
            self._assert_epoch(epoch)
            parsed = urlsplit(url)
            values = parse_qs(parsed.query)
            if (parsed.scheme + "://" + parsed.netloc + parsed.path != AUTHORIZE
                    or values.get("resource") != [RESOURCE] or values.get("scope") != [SCOPES]
                    or values.get("code_challenge_method") != ["S256"] or not values.get("state")
                    or values.get("redirect_uri") != [redirect]):
                raise AccountError("oauth_configuration_invalid")
            callback.expected_state = values["state"][0]
            with self._lock:
                self._assert_epoch(epoch)
                self._authorization = url
        provider = _Provider(server_url=RESOURCE, client_metadata=metadata, storage=storage,
                             redirect_handler=redirect_handler if callback else None,
                             callback_handler=callback.wait if callback else None,
                             timeout=self.login_timeout, interactive=callback is not None,
                             epoch_check=lambda: self._assert_epoch(epoch))
        async with self._client() as client:
            prm_response = await client.get(PRM)
            meta_response = await client.get(DISCOVERY)
            if prm_response.status_code != 200 or meta_response.status_code != 200:
                raise AccountError("oauth_configuration_invalid")
            from mcp.shared.auth import ProtectedResourceMetadata
            prm = ProtectedResourceMetadata.model_validate_json(prm_response.content)
            await provider._validate_resource_match(prm)
            provider.context.protected_resource_metadata = prm
            provider.context.auth_server_url = ISSUER
            provider.context.oauth_metadata = OAuthMetadata.model_validate_json(meta_response.content)
            provider.validate_metadata()
            callback and setattr(callback, "issuer_required", meta_response.json().get("authorization_response_iss_parameter_supported", False))
        return provider

    def _client(self, provider=None):
        return httpx.AsyncClient(auth=provider, transport=self.http_transport, follow_redirects=False,
                                 timeout=httpx.Timeout(self.request_timeout), trust_env=False)

    async def _mcp(self, provider, name=None, arguments=None):
        async with self._client(provider) as client:
            async with streamable_http_client(RESOURCE, http_client=client) as (read, write, _):
                timeout = self.login_timeout if provider.interactive else self.request_timeout
                async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=timeout)) as session:
                    await session.initialize()
                    if name is None:
                        return {}
                    result = await session.call_tool(name, arguments or {})
                    if result.isError:
                        raise AccountError("cloud_tool_failed")
                    if not isinstance(result.structuredContent, dict):
                        raise AccountError("invalid_cloud_response")
                    return result.structuredContent

    def _failure(self, epoch, code):
        with self.state.locked() as state:
            if state["epoch"] != epoch or state["mode"] != "cloud":
                return
            if code in ("authentication_required", "login_cancelled", "account_changed"):
                state["state"] = "signed_out"
            elif state["state"] != "connected":
                state["state"] = "error"
            state["error"] = code
            state.pop("login_deadline", None)
            if state["state"] == "signed_out":
                state["epoch"] += 1
                try:
                    self.credentials.clear()
                except AccountError:
                    pass

    async def _login(self, epoch):
        token = _account_context.set(True)
        callback = _Loopback(self.login_timeout)
        try:
            async with asyncio.timeout(self.login_timeout):
                async with self.state.operation(self.login_timeout):
                    self._assert_epoch(epoch)
                    provider = await self._provider(epoch, callback=callback)
                    await self._mcp(provider)
                    self._assert_epoch(epoch)
                    with self.state.locked() as state:
                        if state["epoch"] != epoch:
                            raise AccountError("account_changed")
                        state.update(state="connected")
                        state.pop("error", None)
                        state.pop("login_deadline", None)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self._failure(epoch, "login_timeout" if isinstance(error, TimeoutError) else _account_error(error).code)
        finally:
            await callback.close()
            _account_context.reset(token)

    async def _remote(self, epoch, *, name=None, arguments=None, path=None, params=None):
        token = _account_context.set(True)
        try:
            async with asyncio.timeout(self.request_timeout):
                async with self.state.operation(self.request_timeout):
                    self._assert_epoch(epoch)
                    provider = await self._provider(epoch)
                    if path is None:
                        result = await self._mcp(provider, name, arguments)
                    else:
                        async with self._client(provider) as client:
                            response = await client.get(API_ORIGIN + path, params=params)
                            if response.status_code in (401, 403):
                                raise AccountError("authentication_required")
                            if response.status_code >= 500:
                                raise AccountError("cloud_unavailable")
                            if response.status_code not in (200, 404):
                                raise AccountError("cloud_request_failed")
                            result = response.json()
                            if not isinstance(result, dict):
                                raise AccountError("invalid_cloud_response")
                    self._assert_epoch(epoch)
                    with self.state.locked() as state:
                        if state["epoch"] != epoch or state["mode"] != "cloud":
                            raise AccountError("account_changed")
                        state.update(state="connected")
                        state.pop("error", None)
                    return result
        except Exception as error:
            safe = _account_error(error)
            self._failure(epoch, safe.code)
            raise safe from None
        finally:
            _account_context.reset(token)

    def _call(self, *, expected_epoch=None, **kwargs):
        state = self.state.read()
        if expected_epoch is not None and state["epoch"] != expected_epoch:
            raise AccountError("account_changed")
        if state["mode"] != "cloud" or state["state"] not in ("connected", "error"):
            raise AccountError("authentication_required")
        future = self._submit(self._remote(state["epoch"], **kwargs))
        try:
            result = future.result(timeout=self.request_timeout + 2)
            self._assert_epoch(state["epoch"])
            return result
        except FutureTimeout:
            future.cancel()
            raise AccountError("cloud_unavailable") from None

    def call_tool(self, name, args=None, *, expected_epoch=None):
        # The deployed server is the authority for supported tool names. Names
        # remain bounded; an unsupported tool returns an explicit error, never SQLite.
        if not isinstance(name, str) or not name or len(name) > 100 or (args is not None and not isinstance(args, dict)):
            raise AccountError("unsupported_cloud_operation")
        return self._call(name=name, arguments=args, expected_epoch=expected_epoch)

    def request_api(self, method, path, params=None, json=None, *, expected_epoch=None):
        import re
        valid = path in ("/v1/changes", "/v1/languages", "/v1/settings") if isinstance(path, str) else False
        if isinstance(path, str) and re.fullmatch(r"/v1/points/[1-9][0-9]{0,15}", path):
            valid = int(path.rsplit("/", 1)[1]) <= 9007199254740991
        if method != "GET" or not valid or params or json is not None:
            raise AccountError("unsupported_cloud_operation")
        return self._call(path=path, expected_epoch=expected_epoch)

    def close(self):
        """Release this process's callback/worker, without signing other clients out."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            if self._login_future:
                self._login_future.cancel()
            loop, thread = self._loop, self._thread
        if loop:
            async def shutdown():
                current = asyncio.current_task()
                pending = [task for task in asyncio.all_tasks() if task is not current]
                for task in pending:
                    task.cancel()
                if pending:
                    await asyncio.gather(*pending, return_exceptions=True)
            try:
                asyncio.run_coroutine_threadsafe(shutdown(), loop).result(timeout=2)
            except Exception:
                pass
            loop.call_soon_threadsafe(loop.stop)
            thread.join(timeout=2)
