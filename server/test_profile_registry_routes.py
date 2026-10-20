"""Profile-registry route characterization, fixed original eff8df6.

The backing store is a fake, scoped in sys.modules and the server package.
No actual profile, config store or native Hermes profile is modified.
"""
import sys
from types import SimpleNamespace

import pytest

import server
from server.routes import core

FIELDS = ["personality", "system_prompt", "profile_path", "model", "provider",
          "harness_ref", "display_name", "identity_mode", "slot_order"]


class IgnoredContext:
    def __getattribute__(self, name):
        raise AssertionError(f"context remains unused: {name}")


@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("REPOCIV_CONFIG_DIR", str(tmp_path / "config"))
    state = SimpleNamespace(error=None, listed={"fixture": {"harness": "hermes"}},
                            entry={"harness": "fake"}, deleted=True)
    trace = []

    def step(name, *args):
        trace.append((name, *args))
        if state.error is not None:
            raise state.error
        return {"list": state.listed, "upsert": state.entry, "delete": state.deleted}[name]

    store = SimpleNamespace(list_profiles=lambda: step("list"),
                            upsert_profile=lambda name, harness, **kw: step("upsert", name, harness, kw),
                            delete_profile=lambda name: step("delete", name))
    monkeypatch.setitem(sys.modules, "server.config_store", store)
    monkeypatch.setattr(server, "config_store", store, raising=False)
    return SimpleNamespace(state=state, trace=trace, store=store, monkeypatch=monkeypatch)


def test_listing_preserves_reference_and_ignores_context(env):
    status, body = core.get_profiles(IgnoredContext())
    assert (status, body) == (200, {"profiles": env.state.listed})
    assert body["profiles"] is env.state.listed
    assert env.trace == [("list",)]


@pytest.mark.parametrize("value", [None, [], {}, "unchecked"])
def test_list_result_remains_unchecked(env, value):
    env.state.listed = value
    assert core.get_profiles(None) == (200, {"profiles": value})


@pytest.mark.parametrize("body", [{}, {"name": "n"}, {"harness": "h"},
                                  {"name": None, "harness": "h"}, {"name": 1, "harness": "h"},
                                  {"name": "n", "harness": False}])
def test_upsert_rejects_nonstrings_without_store_call(env, body):
    assert core.post_profiles(body, IgnoredContext()) == (400, {"error": "name and harness are required strings"})
    assert env.trace == []


@pytest.mark.parametrize(("name", "harness"), [("", ""), (" N ", " H "), ("á_名", "future-harness")])
def test_upsert_forwards_raw_strings_and_all_optional_defaults(env, name, harness):
    status, body = core.post_profiles({"name": name, "harness": harness, "unknown": 42}, IgnoredContext())
    assert (status, body) == (200, {"profile": env.state.entry})
    assert body["profile"] is env.state.entry
    assert env.trace == [("upsert", name, harness, dict.fromkeys(FIELDS))]


def test_upsert_forwards_optional_values_without_coercion_or_reordering(env):
    values = ["", None, " ~/path ", 0, False, [], {"key": "value"}, " unknown ", -1]
    options = dict(zip(FIELDS, values, strict=True))
    result = core.post_profiles({"name": "N", "harness": "H", **options}, None)
    assert result == (200, {"profile": env.state.entry})
    assert env.trace == [("upsert", "N", "H", options)]
    assert list(env.trace[0][3]) == FIELDS
    for key, value in options.items():
        assert env.trace[0][3][key] is value


@pytest.mark.parametrize("which", ["list", "upsert", "delete"])
@pytest.mark.parametrize("error", [ValueError("fixture-error"), TypeError("fixture-error"), OSError("fixture-error")])
def test_store_exception_boundaries(env, which, error):
    env.state.error = error
    calls = {"list": lambda: core.get_profiles(None),
             "upsert": lambda: core.post_profiles({"name": "N", "harness": "H"}, None),
             "delete": lambda: core.post_profiles_delete({"name": "N"}, None)}
    if isinstance(error, ValueError) and which != "list":
        assert calls[which]() == (400, {"error": "fixture-error"})
    else:
        with pytest.raises(type(error), match="^fixture-error$") as caught:
            calls[which]()
        assert caught.value is error
    assert len(env.trace) == 1
    assert env.trace[0][0] == which


@pytest.mark.parametrize("value", [None, 12, [], ""])
@pytest.mark.parametrize("which", ["upsert", "delete"])
def test_nondict_body_still_raises_instead_of_new_validation(env, value, which):
    handler = core.post_profiles if which == "upsert" else core.post_profiles_delete
    with pytest.raises(AttributeError):
        handler(value, None)
    assert env.trace == []


@pytest.mark.parametrize("body", [{}, {"name": None}, {"name": 0}, {"name": False}])
def test_delete_rejects_nonstring_name(env, body):
    assert core.post_profiles_delete(body, None) == (400, {"error": "name is required and must be a string"})
    assert env.trace == []


@pytest.mark.parametrize("deleted", [False, None, 0, "", [], True, 1, "truthy"])
def test_delete_truthiness_and_raw_name_error_repr(env, deleted):
    env.state.deleted = deleted
    name = " spaced'\n "
    expected = (200, {"ok": True}) if deleted else (404, {"error": f"profile {name!r} not found"})
    assert core.post_profiles_delete({"name": name}, IgnoredContext()) == expected
    assert env.trace == [("delete", name)]


def test_empty_delete_name_still_reaches_store(env):
    assert core.post_profiles_delete({"name": ""}, None) == (200, {"ok": True})
    assert env.trace == [("delete", "")]


@pytest.mark.parametrize(("key", "caught"), [("name", False), ("harness", False), ("personality", True)])
def test_body_get_exception_scope_and_order(env, key, caught):
    class Body:
        def get(self, field):
            env.trace.append(("get", field))
            if field == key:
                raise ValueError("body-failure")
            return {"name": "N", "harness": "H"}.get(field)

    if caught:
        assert core.post_profiles(Body(), None) == (400, {"error": "body-failure"})
    else:
        with pytest.raises(ValueError, match="^body-failure$"):
            core.post_profiles(Body(), None)
    reads = ["name", "harness", *FIELDS]
    assert env.trace == [("get", field) for field in reads[:reads.index(key)+1]]


def test_store_module_is_captured_before_body_get_but_method_before_optional_reads(env):
    captured = env.store.upsert_profile

    class Body:
        def get(self, field):
            env.trace.append(("get", field))
            if field == "name":
                env.monkeypatch.setattr(server, "config_store", SimpleNamespace())
            if field == "personality":
                env.store.upsert_profile = lambda *_args, **_kw: pytest.fail("callee was already captured")
            return {"name": "N", "harness": "H"}.get(field)

    assert core.post_profiles(Body(), None) == (200, {"profile": env.state.entry})
    assert env.trace == [("get", field) for field in ["name", "harness", *FIELDS]] + [
        ("upsert", "N", "H", dict.fromkeys(FIELDS))]
    assert captured is not env.store.upsert_profile


def test_delete_bool_error_stays_outside_store_valueerror_catch(env):
    class Deleted:
        def __bool__(self):
            raise ValueError("bool-failure")

    env.state.deleted = Deleted()
    with pytest.raises(ValueError, match="^bool-failure$"):
        core.post_profiles_delete({"name": "N"}, None)
    assert env.trace == [("delete", "N")]


def test_registry_and_shim_keep_facade_identity_and_public_docs():
    from server import http_routes
    from server.routes import registry

    for name, table, path in [("get_profiles", registry.GET_EXACT, "/api/profiles"),
                              ("post_profiles", registry.POST_EXACT, "/api/profiles"),
                              ("post_profiles_delete", registry.POST_EXACT, "/api/profiles/delete")]:
        assert getattr(core, name) is getattr(http_routes, name) is table[path]
        assert getattr(core, name).__doc__
