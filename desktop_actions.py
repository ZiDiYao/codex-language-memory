"""UI-only account controls for the desktop's shared data-source router."""

ACCOUNT_ACTIONS = {
    "account/status": "status",
    "account/connect": "begin_login",
    "account/disconnect": "disconnect",
}


def account_action(store, action, arguments):
    if action not in ACCOUNT_ACTIONS or not isinstance(arguments, dict) or arguments:
        raise ValueError("Invalid account action")
    account = getattr(store, "account", None)
    if account is None:
        if action != "account/status":
            raise ValueError("Account connection unavailable")
        return {"mode": "local", "state": "signed_out", "epoch": 0, "can_connect": False,
                "capabilities": {"export": True, "speech": True, "study": True}}
    value = getattr(account, ACCOUNT_ACTIONS[action])()
    public = {"mode", "state", "epoch", "capabilities", "authorization_url", "can_connect", "error"}
    result = {key: item for key, item in value.items() if key in public}
    result.setdefault("can_connect", True)
    cloud = result.get("mode") == "cloud"
    result.setdefault("capabilities", {
        "export": not cloud, "speech": not cloud or result.get("state") == "connected", "study": not cloud,
    })
    return result


def connection_error(error):
    """Keep stable account errors usable without exposing transport/provider details."""
    code = getattr(error, "code", None)
    authentication = {"cloud_not_connected", "authentication_required"}
    conflict = {"account_changed", "connection_epoch_required", "account_busy", "cloud_import_account_mismatch"}
    unavailable = {"cloud_unavailable", "credential_store_unavailable", "credential_store_denied",
                   "credential_store_interaction_required", "credential_store_app_identity",
                   "account_state_unavailable", "invalid_cloud_response", "cloud_import_unavailable", "capture_budget_exceeded",
                   "history_view_unavailable"}
    invalid = {"cloud_feature_unavailable", "unsupported_cloud_operation", "cloud_request_failed", "cloud_tool_failed", "cloud_import_too_large"}
    if code not in authentication | conflict | unavailable | invalid:
        return None
    return (401 if code in authentication else 409 if code in conflict else 503 if code in unavailable else 400,
            {"error": code})
