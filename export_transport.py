"""Account-bound page export delivery and acknowledgements, without file caching."""
from contextlib import contextmanager
from dataclasses import dataclass
import secrets
from threading import Lock

from desktop_store import CloudAccountUnavailable
from exports import ExportError, ExportRequest, build_export, export_scope


@dataclass(frozen=True)
class ExportBinding:
    mode: str | None
    epoch: int | None


def envelope(payload):
    if not isinstance(payload, dict):
        raise ValueError("Invalid export request")
    arguments = dict(payload)
    epoch = arguments.pop("expected_epoch", None)
    if epoch is not None and (type(epoch) is not int or epoch < 0):
        raise ValueError("Invalid connection epoch")
    return arguments, epoch


def check_binding(store, binding):
    if binding.mode is None:  # A standalone Store is an explicit local fixture.
        return
    current = store.connection_status()
    if current["mode"] != binding.mode or current["epoch"] != binding.epoch:
        raise CloudAccountUnavailable("account_changed")
    if current["mode"] == "cloud" and current["state"] != "connected":
        raise CloudAccountUnavailable()


@contextmanager
def export_binding(store, expected_epoch):
    binder = getattr(store, "expect_epoch", None)
    if binder is None:
        if getattr(store, "account", None) is not None:
            raise CloudAccountUnavailable("connection_epoch_required")
        yield ExportBinding(None, None)
        return
    with binder(expected_epoch, require_cloud=True):
        current = store.connection_status()
        binding = ExportBinding(current["mode"], current["epoch"])
        check_binding(store, binding)
        yield binding
        check_binding(store, binding)


class ExportTransport:
    def __init__(self, store):
        self.store = store
        self.pending = {}
        self.completed = {}
        self.lock = Lock()

    def prepare(self, payload, present=lambda exported, token: (exported, token)):
        arguments, epoch = envelope(payload)
        selection = ExportRequest.model_validate(arguments)
        token = secrets.token_urlsafe(24)
        try:
            with export_binding(self.store, epoch) as binding:
                exported = build_export(self.store, selection)
                if len(exported.data) > 24 * 1024 * 1024:
                    raise ExportError("exportTooLarge")
                # Presentation may encode a large file. Check again afterwards,
                # before exposing any bytes or receipt to the page.
                result = present(exported, token)
                check_binding(self.store, binding)
                with self.lock:
                    while len(self.pending) >= 16:
                        self.pending.pop(next(iter(self.pending)))
                    self.pending[token] = (binding, selection.model_copy(deep=True), dict(exported.receipt))
            return result
        except Exception:
            with self.lock:
                self.pending.pop(token, None)
            raise

    def complete(self, payload):
        arguments, epoch = envelope(payload)
        token = arguments.get("receipt")
        if set(arguments) != {"receipt"} or not isinstance(token, str) or not 1 <= len(token) <= 100:
            raise ValueError("Invalid export receipt")
        with export_binding(self.store, epoch) as binding, self.lock:
            pending = self.pending.get(token)
            original = pending[0] if pending else self.completed.get(token)
            if original is None:
                raise ValueError("Invalid export receipt")
            if original != binding:
                raise CloudAccountUnavailable("account_changed")
            if not pending:
                return {"status": "ok", "replayed": True}
            _, selection, receipt = pending
            self.store.export_receipt(export_scope(selection), receipt)
            check_binding(self.store, binding)
            del self.pending[token]
            while len(self.completed) >= 32:
                self.completed.pop(next(iter(self.completed)))
            self.completed[token] = binding
            return {"status": "ok", "replayed": False}
