from server import endpoint_usage


def test_endpoint_usage_records_and_persists(tmp_path):
    endpoint_usage.init(tmp_path)

    endpoint_usage.record("GET", "/health", 200)
    endpoint_usage.record("GET", "/health", 200)
    endpoint_usage.record("POST", "/commands/abc-123/cancel", 200)
    endpoint_usage.record("POST", "/commands/def-456/cancel", 404)

    stats = endpoint_usage.get_stats()
    health = next(row for row in stats if row["method"] == "GET" and row["path"] == "/health")
    cancel = next(row for row in stats if row["method"] == "POST" and row["path"] == "/commands/:id/cancel")

    assert health["count"] == 2
    assert health["statusCounts"] == {"200": 2}
    assert cancel["count"] == 2
    assert cancel["statusCounts"] == {"200": 1, "404": 1}
    assert (tmp_path / "endpoint_usage.json").exists()

    endpoint_usage.init(tmp_path)
    assert any(row["path"] == "/commands/:id/cancel" for row in endpoint_usage.get_stats())


def test_endpoint_usage_normalizes_dynamic_paths():
    assert endpoint_usage.normalize_path("/approvals/cmd-1/approve") == "/approvals/:id/approve"
    assert endpoint_usage.normalize_path("/api/wonders/bibliotheca/health") == "/api/wonders/:id/health"
    assert endpoint_usage.normalize_path("/tasks/repo/ISSUE-1/circuit-status") == "/tasks/:repo/:issue/circuit-status"
    assert endpoint_usage.normalize_path("/api/labhub/status/city-1") == "/api/labhub/status/:city_id"
