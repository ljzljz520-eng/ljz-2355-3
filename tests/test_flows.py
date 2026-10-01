"""End-to-end flows: annotated export provenance, design version freeze,
component dependencies, and consistency between explanations and computed
contrast (text description must equal the running example)."""
import json
import re
import time


def _report(client):
    rid = client.post("/api/reports", json={}).json()["report_id"]
    for _ in range(30):
        rep = client.get(f"/api/reports/{rid}").json()
        if rep["summary"]:
            return rep
        time.sleep(0.1)
    raise AssertionError("timeout")


def test_export_annotation_is_traceable(client):
    d = client.get("/api/export/input-field/light/error").json()
    assert d["signature"]
    roles = {a["role"] for a in d["annotations"]}
    assert {"foreground", "background", "icon_color", "font_size"} <= roles
    fg = next(a for a in d["annotations"] if a["role"] == "foreground")
    assert fg["token_path"] == "color.danger.text"
    assert fg["resolved_value"] == "#b91c1c"
    assert fg["winner_theme"] == "light"
    assert fg["override_priority"] == ["base", "light"]
    # provenance embedded inside the exportable svg
    meta = re.search(r'<metadata[^>]*>(.*?)</metadata>', d["svg"], re.S)
    assert meta
    payload = json.loads(meta.group(1))
    assert payload["component"] == "input-field"
    assert payload["token_version_hash"] == d["signature"]
    assert d["svg"].count("@source") == len(d["annotations"])


def test_freeze_creates_persisted_version_with_dependencies(client):
    r = client.post("/api/versions/freeze",
                    json={"version": "v2026.2", "note": "第二版"})
    assert r.status_code == 200
    versions = {v["version"]: v for v in client.get("/api/versions").json()}
    assert "v2026.1" in versions and "v2026.2" in versions
    snap = client.get("/api/versions/v2026.1").json()
    # frozen snapshot keeps resolved values for every theme
    assert snap["themes"]["light"]["tokens"]["color.brand.primary"]["value"] == "#1d4ed8"
    assert snap["themes"]["light"]["tokens"]["color.brand.primary"]["winner"] == "light"
    deps = client.get("/api/dependencies").json()["edges"]
    pairs = {(e["from"], e["to"]) for e in deps}
    assert ("button-primary", "icon-button") in pairs
    assert ("input-field", "icon-button") in pairs


def test_rendered_preview_matches_report_contrast(client):
    """The number the UI shows on the running example is computed from the
    same resolved fg/bg the report audits -> description cannot drift."""
    preview = client.get("/api/components/input-field/rendered").json()
    pv = next(p for p in preview["previews"]
              if p["state"] == "helper" and p["theme_slug"] == "light")
    rep = _report(client)
    finding = next(f for f in rep["findings"]
                   if f["rule"] == "contrast_state"
                   and f["evidence"].get("state") == "helper"
                   and f["evidence"].get("theme_slug") == "light")
    assert pv["contrast"]["ratio"] == finding["evidence"]["ratio"]
    assert pv["contrast"]["passes"] is False
    assert pv["values"]["foreground"]["value"] == finding["evidence"]["foreground"]
    assert pv["values"]["background"]["value"] == finding["evidence"]["background"]
    # winner attribution present in the live preview narrative
    assert pv["values"]["foreground"]["winner"] == "light"


def test_disabled_preview_carries_exempt_flag(client):
    d = client.get("/api/components/button-primary/rendered").json()
    disabled = [p for p in d["previews"] if p["state"] == "disabled"]
    assert disabled and all(p["disabled"] for p in disabled)
    assert all(p["contrast"] is None for p in disabled)


def test_icon_preview_flags_hardcoded_token(client):
    d = client.get("/api/components/icon-button/rendered").json()
    pv = next(p for p in d["previews"]
              if p["state"] == "default" and p["theme_slug"] == "light")
    assert pv["values"]["icon_color"]["winner"] == "<hard-coded>"
    assert pv["values"]["icon_color"]["value"] == "#999999"


def test_coverage_endpoint_distinguishes_inherited_and_owned(client):
    cov = {r["theme_slug"]: r for r in client.get("/api/coverage").json()}
    assert "color.border.strong" in cov["dark"]["missing_overrides"]
    # base declares it itself, light declares it itself
    assert cov["base"]["missing_overrides"] == []
    assert cov["light"]["missing_overrides"] == []


def test_confirmation_requires_completed_screenshot(client):
    # icon-button/light/default is pending only -> cannot confirm
    r = client.post("/api/confirmations", json={
        "component_slug": "icon-button", "theme_slug": "light",
        "state": "default", "designer": "mina"})
    assert r.status_code == 422


def test_reconfirm_requires_fresh_screenshot_then_clears(client):
    """Upstream token change forces re-review. Re-confirming against the OLD
    screenshot must not clear the flag; after a fresh screenshot is rendered
    with current tokens, confirmation clears it."""
    # make roy stale
    client.put("/api/tokens", json={
        "theme_slug": "light", "path": "color.text.strong",
        "value": "#0a0f1c", "type": "color"})
    roy = next(c for c in client.get("/api/confirmations").json()
               if c["designer"] == "roy")
    assert roy["status"] == "needs_rereview"

    # old screenshot cannot validate the new token version
    client.post("/api/confirmations", json={
        "component_slug": "input-field", "theme_slug": "light",
        "state": "default", "designer": "roy"})
    roy2 = next(c for c in client.get("/api/confirmations").json()
                if c["designer"] == "roy")
    assert roy2["status"] == "needs_rereview"

    # render a fresh screenshot (carries the current token hash) then confirm
    shot = client.post("/api/screenshots", json={
        "component_slug": "input-field", "theme_slug": "light",
        "state": "default"}).json()
    client.post("/api/confirmations", json={
        "component_slug": "input-field", "theme_slug": "light",
        "state": "default", "designer": "roy"})
    roy3 = next(c for c in client.get("/api/confirmations").json()
                if c["designer"] == "roy")
    assert roy3["status"] == "confirmed"
    assert roy3["confirmed_token_hash"] == shot["token_version_hash"]
    assert roy3["confirmed_token_hash"] == roy3["current_token_hash"]


def test_font_size_rendered_with_provenance(client):
    exp = client.get("/api/themes/light/expand").json()
    md = exp["tokens"]["font.size.md"]
    assert md["value"].endswith("px")
    assert md["winner"]["theme_slug"] == "light"


def test_brand_and_themes_listed(client):
    brands = client.get("/api/brands").json()
    assert any(b["slug"] == "acme" for b in brands)
    slugs = {t["slug"] for t in client.get("/api/themes").json()}
    assert {"base", "light", "dark", "experimental"} <= slugs
