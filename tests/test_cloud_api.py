"""Offline HTTP/MCP acceptance tests with real RSA JWT signatures and isolated SQL storage."""

import asyncio
import json
from pathlib import Path
import tempfile
import time
import unittest

from cryptography.hazmat.primitives.asymmetric import rsa
import jwt
from sqlalchemy import text
from starlette.testclient import TestClient

from cloud.app import create_app, database_readiness
from cloud.auth import JWTVerifier
from cloud.config import CloudSettings
from cloud.database import create_database, create_session_factory
from cloud.models import Base
from cloud.repository import Repository


POINT = {
    "kind": "word", "language": "en", "title": "rinse", "sense_key": "clean-with-water",
    "meaning": "用清水冲洗", "explanation": "Rinse something with water means wash away soap or dirt.",
    "examples": [{"text": "Rinse your hands with water."}, {"text": "Rinse the cup before you use it."}],
    "scenes": ["Cleaning & hygiene"],
}


class OfflineJWKS(jwt.PyJWKClient):
    """Exercise the SDK's real JWKS key selection without network access."""

    def __init__(self, keys):
        super().__init__("https://issuer.example/jwks")
        self.keys = keys

    def fetch_data(self):
        return {"keys": self.keys}


class CloudAPITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.public_jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(cls.private.public_key()))
        cls.public_jwk.update(kid="test-key", alg="RS256", use="sig")

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.settings = CloudSettings(
            database_url="sqlite+pysqlite:///" + str(Path(directory.name) / "cloud.sqlite3"),
            public_url="http://localhost:8080", auth_issuer="https://issuer.example/",
            auth_audience="https://memory.example/mcp", auth_jwks_url="https://issuer.example/jwks",
            allow_insecure_local=True,
        )
        self.engine = create_database(self.settings.database_url, allow_sqlite=True)
        self.addCleanup(self.engine.dispose)
        Base.metadata.create_all(self.engine)
        sessions = create_session_factory(self.engine)
        self.factory = lambda principal: Repository(sessions, principal)
        self.verifier = JWTVerifier(self.settings, jwks_client=OfflineJWKS([self.public_jwk]))

        def readiness():
            with self.engine.connect() as connection:
                connection.execute(text("SELECT 1"))
            return True

        self.app = create_app(self.settings, self.factory, verifier=self.verifier, readiness=readiness)
        self.client = self.enterContext(TestClient(self.app, base_url=self.settings.public_url, raise_server_exceptions=False))

    def token(self, subject="alice", **claims):
        payload = {
            "iss": self.settings.auth_issuer, "sub": subject, "aud": self.settings.auth_audience,
            "iat": int(time.time()) - 1, "exp": int(time.time()) + 300,
            "scope": "memory:read memory:write", **claims,
        }
        return jwt.encode(payload, self.private, algorithm="RS256", headers={"kid": "test-key"})

    def headers(self, subject="alice", **claims):
        return {"Authorization": "Bearer " + self.token(subject, **claims)}

    def capture(self, subject="alice", request_id="capture-first", point=None):
        return self.client.post("/v1/captures", headers=self.headers(subject), json={
            "request_id": request_id, "items": [POINT if point is None else point],
        })

    def rpc(self, subject="alice", method="tools/list", params=None):
        return self.client.post("/mcp", headers={
            **self.headers(subject), "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-03-26",
        }, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})

    def test_health_metadata_and_all_data_endpoints_require_authentication(self):
        self.assertEqual(self.client.get("/healthz").json(), {"status": "ok"})
        self.assertEqual(self.client.get("/readyz").status_code, 200)
        metadata = self.client.get("/.well-known/oauth-protected-resource/mcp")
        self.assertEqual(metadata.status_code, 200)
        self.assertEqual(metadata.json()["resource"], self.settings.resource_url)
        self.assertEqual(metadata.json()["authorization_servers"], [self.settings.auth_issuer])
        for path in ("/v1/settings", "/v1/points", "/v1/points/1", "/v1/scenes", "/v1/review-queue"):
            with self.subTest(path=path):
                result = self.client.get(path)
                self.assertEqual(result.status_code, 401)
                self.assertIn("resource_metadata=", result.headers["www-authenticate"])
        self.assertEqual(self.client.post("/v1/captures", json={}).status_code, 401)
        self.assertEqual(self.client.post("/mcp", json={}).status_code, 401)

    def test_real_jwt_rejects_bad_signature_issuer_audience_expiry_subject_and_scope(self):
        other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        bad_signature = jwt.encode({"iss": self.settings.auth_issuer, "sub": "alice", "aud": self.settings.auth_audience,
                                    "exp": int(time.time()) + 300}, other_key, algorithm="RS256", headers={"kid": "test-key"})
        tokens = [bad_signature, self.token(iss="https://attacker.example/"), self.token(aud="another-api"),
                  self.token(exp=int(time.time()) - 60), self.token(sub=""), self.token(exp="9999999999"),
                  self.token(exp=True), self.token(exp=float("inf")), self.token(exp=None)]
        for token in tokens:
            with self.subTest(token_type=tokens.index(token)):
                result = self.client.get("/v1/points", headers={"Authorization": "Bearer " + token})
                self.assertEqual(result.status_code, 401)
        missing_scope = self.client.get("/v1/points", headers=self.headers(scope="memory:read"))
        self.assertEqual(missing_scope.status_code, 403)
        unsigned = jwt.encode({"sub": "alice"}, key="", algorithm="none", headers={"kid": "test-key"})
        symmetric = jwt.encode({"sub": "alice"}, key="not-a-trusted-signing-key-32-chars", algorithm="HS256", headers={"kid": "test-key"})
        for token in (unsigned, symmetric):
            self.assertIsNone(asyncio.run(self.verifier.verify_token(token)))

    def test_required_claims_and_jwks_outage_fail_closed(self):
        payload = jwt.decode(self.token(), self.private.public_key(), algorithms=["RS256"],
                             audience=self.settings.auth_audience, issuer=self.settings.auth_issuer)
        for name in ("iss", "sub", "aud", "exp"):
            incomplete = {key: value for key, value in payload.items() if key != name}
            token = jwt.encode(incomplete, self.private, algorithm="RS256", headers={"kid": "test-key"})
            self.assertIsNone(asyncio.run(self.verifier.verify_token(token)), name)

        class UnavailableJWKS:
            def get_signing_key_from_jwt(self, token):
                raise jwt.PyJWKClientConnectionError("Provider unavailable")

        verifier = JWTVerifier(self.settings, jwks_client=UnavailableJWKS())
        self.assertIsNone(asyncio.run(verifier.verify_token(self.token())))

    def test_rest_request_size_and_duplicate_queries_are_bounded(self):
        result = self.client.post("/v1/captures", headers={**self.headers(), "Content-Type": "application/json"},
                                  content=b'{"oversized":"' + b"x" * (1024 * 1024) + b'"}')
        self.assertEqual(result.status_code, 413)
        result = self.client.get("/v1/points?language=en&language=fr", headers=self.headers())
        self.assertEqual(result.status_code, 422)

    def test_rest_capture_retry_edit_revision_and_cross_user_isolation(self):
        saved = self.capture().json()
        self.assertEqual(saved["results"][0]["status"], "added")
        point_id = saved["results"][0]["id"]
        replay = self.capture().json()
        self.assertTrue(replay["replayed"])
        alice = self.client.get("/v1/points", headers=self.headers()).json()
        self.assertEqual(len(alice["records"]), 1)
        self.assertEqual(alice["records"][0]["encounter_count"], 1)
        self.assertEqual(self.client.get("/v1/points", headers=self.headers("bob")).json()["records"], [])
        for method, body in (("GET", None), ("PATCH", {"patch": {"note": "stolen"}}), ("DELETE", None)):
            result = self.client.request(method, f"/v1/points/{point_id}", headers=self.headers("bob"), json=body)
            self.assertEqual(result.status_code, 404)
        before = self.client.get(f"/v1/points/{point_id}", headers=self.headers()).json()["record"]
        update = self.client.patch(f"/v1/points/{point_id}", headers=self.headers(), json={
            "patch": {"note": "My rinse note", "scenes": ["Daily routine", "Cleaning & hygiene"]},
            "expected_revision": before["revision"],
        })
        self.assertEqual(update.status_code, 200)
        stale = self.client.patch(f"/v1/points/{point_id}", headers=self.headers(), json={
            "patch": {"note": "stale"}, "expected_revision": before["revision"],
        })
        self.assertEqual(stale.status_code, 409)
        bob = self.capture("bob").json()
        self.assertEqual(bob["results"][0]["status"], "added")
        self.assertNotEqual(bob["results"][0]["id"], point_id)
        self.assertEqual(self.client.get("/v1/settings", headers=self.headers()).status_code, 200)
        self.client.patch("/v1/settings", headers=self.headers(), json={"enabled": False})
        self.assertTrue(self.client.get("/v1/settings", headers=self.headers("bob")).json()["enabled"])

    def test_scenes_type_filters_reviews_and_no_client_selected_tenant(self):
        point_id = self.capture().json()["results"][0]["id"]
        scenes = self.client.get("/v1/scenes", headers=self.headers()).json()["scenes"]
        self.assertEqual(scenes[0]["name"], "Cleaning & hygiene")
        self.assertEqual(self.client.get("/v1/scenes", headers=self.headers("bob")).json()["scenes"], [])
        expression = dict(POINT, title="rinse off", kind="expression", sense_key="remove-with-water")
        self.capture(request_id="capture-expression", point=expression)
        filtered = self.client.get("/v1/points", headers=self.headers(), params={"scene": "Cleaning & hygiene", "kind": "word"})
        self.assertEqual([point["id"] for point in filtered.json()["records"]], [point_id])
        review = {"record_id": point_id, "request_id": "review-attempt", "review": {"result": "correct", "prompt": "What does rinse mean?", "answer": "冲洗"}}
        self.assertEqual(self.client.post("/v1/reviews", headers=self.headers("bob"), json=review).status_code, 404)
        self.assertEqual(self.client.post("/v1/reviews", headers=self.headers(), json=review).status_code, 200)
        self.assertTrue(self.client.post("/v1/reviews", headers=self.headers(), json=review).json()["replayed"])
        self.assertEqual(self.client.get("/v1/points", headers=self.headers(), params={"user_id": "bob"}).status_code, 422)
        self.assertEqual(self.client.patch("/v1/settings", headers=self.headers(), json={"user_id": "bob"}).status_code, 422)
        self.assertEqual(self.client.get("/v1/points", headers=self.headers(), params={"limit": 999}).status_code, 422)

    def test_mcp_initialize_and_core_tools_share_the_rest_database_with_isolation(self):
        initialized = self.rpc(method="initialize", params={
            "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "offline-test", "version": "1"},
        })
        self.assertEqual(initialized.status_code, 200)
        self.assertIn("result", initialized.json())
        tool_response = self.rpc().json()
        names = {tool["name"] for tool in tool_response["result"]["tools"]}
        self.assertTrue({"save_points", "find_points", "list_scenes", "get_settings", "record_review"} <= names)
        self.assertFalse({"open_memory_page", "start_study", "export_points", "play_speech"} & names)
        saved = self.rpc(method="tools/call", params={"name": "save_points", "arguments": {"request_id": "mcp-capture", "items": [POINT]}})
        self.assertEqual(saved.status_code, 200)
        self.assertFalse(saved.json()["result"].get("isError", False))
        self.assertEqual(len(self.client.get("/v1/points", headers=self.headers()).json()["records"]), 1)
        found = self.rpc("bob", method="tools/call", params={"name": "find_points", "arguments": {}}).json()["result"]
        self.assertEqual(found["structuredContent"]["records"], [])
        expired = self.client.post("/mcp", headers={**self.headers(exp=int(time.time()) - 30), "Accept": "application/json, text/event-stream"}, json={})
        self.assertEqual(expired.status_code, 401)

    def test_configuration_fails_closed_and_readyz_reports_database_failure(self):
        with self.assertRaises(ValueError):
            CloudSettings.from_env({})
        env = {"DATABASE_URL": "postgresql://user:secret@db/memory", "PUBLIC_URL": "http://localhost:8080",
               "AUTH_ISSUER": "https://issuer.example/", "AUTH_AUDIENCE": "memory", "AUTH_JWKS_URL": "https://issuer.example/jwks"}
        with self.assertRaises(ValueError):
            CloudSettings.from_env(env)
        env["CLOUD_ALLOW_INSECURE_LOCAL"] = "true"
        self.assertEqual(CloudSettings.from_env(env).port, 8080)
        env["PUBLIC_URL"] = "http://untrusted.example"
        with self.assertRaises(ValueError):
            CloudSettings.from_env(env)
        app = create_app(self.settings, self.factory, verifier=self.verifier, readiness=lambda: False)
        with TestClient(app, base_url=self.settings.public_url) as client:
            self.assertEqual(client.get("/healthz").status_code, 200)
            self.assertEqual(client.get("/readyz").status_code, 503)

    def test_readiness_rejects_empty_and_stale_schema(self):
        from cloud.database import SCHEMA_REVISION

        app = create_app(self.settings, self.factory, verifier=self.verifier,
                         readiness=lambda: database_readiness(self.engine))
        with TestClient(app, base_url=self.settings.public_url) as client:
            self.assertEqual(client.get("/readyz").status_code, 503)
            with self.engine.begin() as connection:
                connection.execute(text("CREATE TABLE alembic_version (version_num VARCHAR(64) PRIMARY KEY)"))
                connection.execute(text("INSERT INTO alembic_version VALUES ('stale_schema')"))
            self.assertEqual(client.get("/readyz").status_code, 503)
            with self.engine.begin() as connection:
                connection.execute(text("UPDATE alembic_version SET version_num = :revision"), {"revision": SCHEMA_REVISION})
            self.assertEqual(client.get("/readyz").status_code, 200)

    def test_database_errors_are_handled_without_leaking_notes_tokens_or_parameters(self):
        sensitive = "private-note-and-database-password-must-never-be-logged"

        class BrokenRepository:
            def query(self, **arguments):
                raise RuntimeError(sensitive)

        app = create_app(self.settings, lambda principal: BrokenRepository(), verifier=self.verifier, readiness=lambda: True)
        with TestClient(app, base_url=self.settings.public_url, raise_server_exceptions=True) as client:
            with self.assertLogs("cloud.app", level="ERROR") as captured:
                result = client.get("/v1/points", headers=self.headers())
            self.assertEqual(result.status_code, 503)
            self.assertEqual(result.json(), {"error": "unavailable"})
            self.assertNotIn(sensitive, "\n".join(captured.output) + result.text)
            with self.assertLogs("cloud.mcp", level="ERROR") as captured:
                result = client.post("/mcp", headers={**self.headers(), "Accept": "application/json, text/event-stream"}, json={
                    "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "find_points", "arguments": {}},
                })
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json()["result"]["structuredContent"], {"status": "failed", "error": "unavailable"})
            self.assertNotIn(sensitive, "\n".join(captured.output) + result.text)


if __name__ == "__main__":
    unittest.main()
