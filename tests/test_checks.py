"""Report rules: alias ring, override gaps, state-bound contrast, disabled
examples, dynamic icon color, legacy token, screenshot interruption."""
import time

import pytest


def _latest_report(client):
    r = client.post("/api/reports", json={})
    rid = r.json()["report_id"]
    for _ in range(30):
        rep = client.get(f"/api/reports/{rid}").json()
        if rep["summary"]:
            return rep
        time.sleep(0.1)
    raise AssertionError("report did not complete")


def test_report_finds_alias_ring(client):
    rep = _latest_report(client)
    rings = [f for f in rep["findings"] if f["rule"] == "alias_cycle"]
    assert rings, "experimental theme alias ring must be flagged"
    paths = {p for f in rings for p in f["evidence"]["cycle"][:-1]}
    assert paths == {"color.brand.primary", "color.brand.accent"}


def test_report_finds_dark_override_gap(client):
    rep = _latest_report(client)
    gaps = [f for f in rep["findings"]
            if f["rule"] == "theme_override_gap"
            and f["evidence"]["theme_slug"] == "dark"]
    assert any(f["evidence"]["missing"] == "color.border.strong" for f in gaps)


def test_legal_color_but_unreadable_pair_in_real_state(client):
    rep = _latest_report(client)
    contrast = [f for f in rep["findings"] if f["rule"] == "contrast_state"]
    helper = [f for f in contrast
              if f["evidence"].get("state") == "helper"
              and f["evidence"].get("theme_slug") == "light"]
    assert helper, "helper text 2.54:1 must fail against real background"
    ev = helper[0]["evidence"]
    assert ev["ratio"] < ev["threshold"]
    assert ev["foreground"] == "#9ca3af"
    assert ev["background"] == "#ffffff"


def test_disabled_state_is_exempt_not_counted_as_pass(client):
    rep = _latest_report(client)
    disabled = [f for f in rep["findings"] if f["rule"] == "disabled_demo"]
    assert disabled
    info = [f for f in disabled if f["severity"] == "info"]
    assert info, "disabled states are recorded as exempt (info), not passes"
    assert all(f["evidence"]["counted_as_pass"] is False for f in info)
    # and no disabled contrast_state error is raised for the disabled rows
    bad = [f for f in rep["findings"]
           if f["rule"] == "contrast_state"
           and f["evidence"].get("state") == "disabled"]
    assert not bad


def test_dynamic_icon_color_hardcoded_and_low_contrast(client):
    rep = _latest_report(client)
    icon = [f for f in rep["findings"] if f["rule"] == "dynamic_icon_color"]
    hardcoded = [f for f in icon if f["evidence"].get("hardcoded")]
    low = [f for f in icon if f["evidence"].get("ratio")]
    assert hardcoded, "hard-coded icon color must be flagged"
    assert any(f["evidence"]["theme_slug"] == "light"
               and f["evidence"]["ratio"] < 3 for f in low)


def test_legacy_component_missing_new_token(client):
    rep = _latest_report(client)
    legacy = [f for f in rep["findings"]
              if f["rule"] == "legacy_component_token"]
    assert any(f["evidence"]["component"] == "legacy-card"
               and f["evidence"]["token"] == "color.focus.ring"
               for f in legacy)


def test_screenshot_interruption_and_pending(client):
    rep = _latest_report(client)
    shots = [f for f in rep["findings"]
             if f["rule"] == "screenshot_interrupted"]
    interrupted = [f for f in shots if f["evidence"].get("fail_step") == "render"]
    pending = [f for f in shots if f["severity"] == "warning"]
    assert interrupted, "interrupted screenshot task must be reported"
    assert pending, "a not-completed (pending) screenshot is a warning"
    assert all(f["evidence"].get("resumable") for f in shots)


def test_screenshot_resume_completes_with_provenance(client):
    r = client.post("/api/screenshots", json={
        "component_slug": "input-field", "theme_slug": "dark",
        "state": "helper", "fail_before_step": "render"})
    assert r.json()["status"] == "interrupted"
    r2 = client.post("/api/screenshots", json={
        "component_slug": "input-field", "theme_slug": "dark",
        "state": "helper", "resume": True})
    done = r2.json()
    assert done["status"] == "completed"
    assert done["token_version_hash"] and done["design_version"]
    art = client.get(f"/api/screenshots/{done['id']}/artifact").text
    assert "design-provenance" in art
    assert done["theme_slug"] in art


def test_stale_confirmation_flagged_then_token_update_marks_more(client):
    rep = _latest_report(client)
    stale = [f for f in rep["findings"] if f["rule"] == "stale_confirmation"]
    assert any(f["evidence"]["designer"] == "mina" for f in stale)

    # update a token that actually changes the light signature (roy confirmed
    # input-field/light; the foreground text token is declared in light)
    r = client.put("/api/tokens", json={
        "theme_slug": "light", "path": "color.text.strong",
        "value": "#0b1220", "type": "color", "designer": "roy"})
    assert r.status_code == 200
    rr = r.json()["confirmations_needs_rereview"]
    assert any(c["designer"] == "roy" and c["theme_slug"] == "light"
               for c in rr)
    rep2 = _latest_report(client)
    assert any(f["rule"] == "stale_confirmation" for f in rep2["findings"])


def test_failing_pairs_via_compare_api(client):
    r = client.post("/api/compare", json={
        "pairs": [["#999999", "#ffffff"], ["#111111", "#000000"]],
        "purpose": "ui"})
    results = r.json()["results"]
    assert results[0]["legal"] and not results[0]["passes"]
    assert not results[1]["passes"]


def test_illegal_color_reported(client):
    r = client.post("/api/compare", json={"pairs": [["bluish", "#fff"]]})
    assert r.json()["results"][0]["legal"] is False
