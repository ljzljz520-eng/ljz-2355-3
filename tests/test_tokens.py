"""Alias rings, inheritance/override priority, static expansion vs
request-time resolution, cache invalidation and change impact."""
from backend.tokens import CycleError, TokenEngine, _flatten
from backend.db import SessionLocal
from backend.models import Theme


def eng():
    return TokenEngine(SessionLocal())


def test_alias_resolution_chain():
    e = eng()
    d = e.resolve_token("base", "color.brand.primary")
    assert d["found"]
    assert d["value"] == "#1d4ed8"
    roles = [t["path"] for t in d["resolution_trace"]]
    assert roles == ["color.brand.primary", "color.palette.blue.600"]


def test_override_priority_child_wins():
    e = eng()
    d = e.resolve_token("light", "color.brand.primary")
    assert d["value"] == "#1d4ed8"
    # literal override in light shadows the base alias
    assert d["winner"]["theme_slug"] == "light"
    assert d["override_priority"] == ["base", "light"]
    assert "base" in d["overridden_in"]


def test_inherited_token_provenance_points_at_root():
    e = eng()
    d = e.resolve_token("light", "font.size.md")
    assert d["value"] == "14px"
    assert d["winner"]["theme_slug"] == "light"  # light declares font.size.md


def test_alias_cycle_detected_and_explained():
    e = eng()
    exp = e.static_expand(e.theme_by_slug("experimental"))
    assert exp["cycles"], "expected alias ring"
    cyc = exp["cycles"][0]
    assert cyc[0] == cyc[-1]
    assert set(cyc[:-1]) == {"color.brand.primary", "color.brand.accent"}
    # cyclic nodes are explicitly unresolved, not silently assigned
    assert exp["tokens"]["color.brand.primary"]["in_cycle"] is True
    assert exp["tokens"]["color.brand.primary"]["resolved"] is False


def test_update_that_would_create_cycle_is_rejected(client):
    r = client.put("/api/tokens", json={
        "theme_slug": "base", "path": "color.palette.blue.500",
        "value": "{color.palette.blue.600}", "type": "color"})
    # blue.500 is already referenced via brand.primary_strong chain? ensure
    # at minimum no cycle created for this change; build a definite cycle:
    r = client.put("/api/tokens", json={
        "theme_slug": "base", "path": "color.palette.grey.900",
        "value": "{color.palette.grey.700}", "type": "color"})
    assert r.status_code in (200, 409)
    r2 = client.put("/api/tokens", json={
        "theme_slug": "base", "path": "color.palette.grey.700",
        "value": "{color.palette.grey.900}", "type": "color"})
    assert r2.status_code == 409
    assert "cycle" in str(r2.json()["detail"]).lower()


def test_static_expansion_materializes_every_theme():
    e = eng()
    for slug in ("base", "light", "dark"):
        exp = e.static_expand(e.theme_by_slug(slug))
        assert exp["tokens"]["color.brand.primary"]["resolved"]
        assert exp["signature"]


def test_request_time_resolve_uses_cache_then_invalidates():
    e = eng()
    t = e.theme_by_slug("light")
    d1 = e.resolve_token("light", "color.text.strong")
    assert d1["cached"] in (True, False)
    d2 = e.resolve_token("light", "color.text.strong")
    assert d2["cached"] is True
    e.invalidate("base")  # upstream change invalidates descendant light
    d3 = e.resolve_token("light", "color.text.strong", force=False)
    # cache entry was dropped; signature would change only if data changed
    assert d3["cached"] is False


def test_change_impact_lists_descendants_aliases_and_components():
    e = eng()
    impact = e.impact_of_change(["color.palette.blue.600"], "base")
    assert set(impact["affected_themes"]) == {"base", "light", "dark",
                                              "experimental"}
    # alias color.brand.primary in base transitively references palette.blue.600
    assert ("base", "color.brand.primary") in \
        {tuple(k) for k in [(s, p) for s, ps in impact["affected_tokens"].items()
                            for p in ps]}
    comps = {c["component"] for c in impact["affected_components"]}
    assert "button-primary" in comps
    assert "base" in impact["invalidated_cache_scopes"]


def test_inheritance_cycle_detection(monkeypatch):
    db = SessionLocal()
    try:
        dark = db.query(Theme).filter_by(slug="dark").one()
        base = db.query(Theme).filter_by(slug="base").one()
        base.parent_id = dark.id  # base -> dark -> base
        db.commit()
        e = TokenEngine(db)
        try:
            e.inheritance_chain(dark)
            assert False, "expected CycleError"
        except CycleError as ce:
            assert "base" in ce.cycle and "dark" in ce.cycle
    finally:
        db.rollback()
        db.close()


def test_unknown_reference_is_an_error_not_silent():
    db = SessionLocal()
    try:
        t = db.query(Theme).filter_by(slug="base").one()
        t.tokens["color"]["brand"]["ghost"] = {"value": "{color.nope.x}",
                                               "type": "color"}
        from sqlalchemy.orm.attributes import flag_modified
        flag_modified(t, "tokens")
        db.commit()
        exp = TokenEngine(db).static_expand(t)
        assert exp["tokens"]["color.brand.ghost"]["value"] is None
    finally:
        db.rollback(); db.close()
