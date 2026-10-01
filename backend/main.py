"""Design guide HTTP API.

Endpoints cover:
* brand + theme inheritance graph inspection
* static theme expansion vs request-time token resolution with provenance
* alias cycle reporting and override-priority explanation
* token writes with cache invalidation + change-impact list and confirmation
  re-review propagation
* design version freeze (PG persisted snapshot + component dependencies)
* background check reports (pollable)
* interruptible/resumable screenshot tasks and traceable annotated export
"""
import threading
import time
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from .checker import generate_report, run_report
from .colorutils import ColorError, contrast_pair, is_legal, parse_color
from .config import SCREENSHOT_DIR, BASE_DIR
from .db import get_db, init_db
from .models import (
    AuditEvent, Brand, CheckReport, Component, ComponentDependency,
    Confirmation, DesignVersion, ScreenshotTask, Theme,
)
from .schemas import (
    CompareRequest, ConfirmationCreate, FreezeVersion, ReportCreate,
    ScreenshotCreate, TokenUpdate,
)
from .screenshots import annotated_export, run_task
from .tokens import CycleError, ResolutionError, TokenEngine, _flatten

app = FastAPI(title="开发设计规范手册 API", version="1.0")


@app.on_event("startup")
def _startup():
    init_db()


def _audit(db, kind, payload):
    db.add(AuditEvent(kind=kind, payload=payload))


# ---------------------------------------------------------------- brands
@app.get("/api/brands")
def brands(db: Session = Depends(get_db)):
    return [{"id": b.id, "name": b.name, "slug": b.slug}
            for b in db.query(Brand).all()]


@app.get("/api/themes")
def themes(db: Session = Depends(get_db)):
    engine = TokenEngine(db)
    rows = []
    for t in db.query(Theme).order_by(Theme.id).all():
        try:
            chain = engine.inheritance_chain(t)
            exp = engine.static_expand(t)
            parent_slug = chain[-2].slug if len(chain) > 1 else None
            rows.append({"slug": t.slug, "name": t.name,
                         "parent": parent_slug,
                         "version": t.version,
                         "signature": exp["signature"],
                         "token_count": len(exp["tokens"]),
                         "cycle_paths": [p for p, n in exp["tokens"].items()
                                         if n["in_cycle"]],
                         "cycles": exp["cycles"]})
        except CycleError as e:
            rows.append({"slug": t.slug, "name": t.name,
                         "version": t.version, "cycle_paths": [],
                         "cycles": [e.cycle], "inheritance_cycle": True})
    return rows


@app.get("/api/inheritance")
def inheritance(db: Session = Depends(get_db)):
    return TokenEngine(db).inheritance_graph()


# ---------------------------------------------------------------- tokens
@app.get("/api/themes/{slug}/expand")
def expand(slug: str, force: bool = False, db: Session = Depends(get_db)):
    engine = TokenEngine(db)
    theme = engine.theme_by_slug(slug)
    if not theme:
        raise HTTPException(404, f"unknown theme {slug}")
    try:
        return engine.static_expand(theme, force=force)
    except CycleError as e:
        raise HTTPException(409, detail={"message": "inheritance cycle",
                                         "cycle": e.cycle})


@app.get("/api/themes/{slug}/tokens/{path:path}")
def resolve(slug: str, path: str, force: bool = False,
            db: Session = Depends(get_db)):
    engine = TokenEngine(db)
    try:
        data = engine.resolve_token(slug, path, force=force)
    except CycleError as e:
        raise HTTPException(409, detail={"message": "alias cycle",
                                         "cycle": e.cycle})
    except ResolutionError as e:
        raise HTTPException(422, detail={"message": str(e), "path": e.path})
    if not data.get("found"):
        raise HTTPException(404, f"token {path} not found in {slug}")
    return data


@app.get("/api/cycles")
def cycles(db: Session = Depends(get_db)):
    engine = TokenEngine(db)
    out = []
    for t in db.query(Theme).all():
        exp = engine.static_expand(t)
        if exp["cycles"]:
            out.append({"theme_slug": t.slug, "cycles": exp["cycles"]})
    return out


@app.get("/api/coverage")
def coverage(db: Session = Depends(get_db)):
    return TokenEngine(db).theme_coverage()


@app.get("/api/cache")
def cache_state(db: Session = Depends(get_db)):
    return TokenEngine(db).cache_state()


@app.post("/api/cache/invalidate")
def cache_invalidate(slug: str | None = None, db: Session = Depends(get_db)):
    TokenEngine(db).invalidate(slug)
    return {"invalidated": True, "scope": slug or "all"}


@app.put("/api/tokens")
def update_token(body: TokenUpdate, db: Session = Depends(get_db)):
    """Update an upstream token. Bumps version, invalidates caches, lists the
    impact and marks affected designer confirmations as needing re-review."""
    engine = TokenEngine(db)
    theme = engine.theme_by_slug(body.theme_slug)
    if not theme:
        raise HTTPException(404, f"unknown theme {body.theme_slug}")

    # capture pre-update signatures of affected themes for confirmation drift
    affected_before = {body.theme_slug} | engine.descendants(body.theme_slug)
    sig_before = {}
    for slug in affected_before:
        t = engine.theme_by_slug(slug)
        if t:
            sig_before[slug] = engine.version_signature(t)

    _set_dotted(theme.tokens, body.path,
                {"value": body.value, **({"type": body.type} if body.type else {})})
    flag_modified(theme, "tokens")
    theme.version += 1
    db.flush()

    # immediate cycle validation for the changed theme
    exp = engine.static_expand(theme, force=True)
    if exp["cycles"]:
        db.rollback()
        raise HTTPException(409, detail={
            "message": "update would create an alias cycle",
            "cycles": exp["cycles"]})

    engine.invalidate(body.theme_slug)
    impact = engine.impact_of_change([body.path], body.theme_slug)

    # recompute signatures and mark confirmations needing re-review
    rereview = []
    for slug in sig_before:
        t = engine.theme_by_slug(slug)
        new_sig = engine.version_signature(t)
        q = db.query(Confirmation).filter(
            Confirmation.theme_slug == slug,
            Confirmation.status == "confirmed")
        for conf in q.all():
            conf.current_token_hash = new_sig
            if new_sig != conf.confirmed_token_hash:
                conf.status = "needs_rereview"
                rereview.append({"confirmation_id": conf.id,
                                 "designer": conf.designer,
                                 "component_id": conf.component_id,
                                 "state": conf.state, "theme_slug": slug})

    _audit(db, "token.update", {"theme": body.theme_slug, "path": body.path,
                                "value": body.value, "note": body.note,
                                "designer": body.designer,
                                "impact_themes": impact["affected_themes"]})
    db.commit()
    return {"updated": True, "theme": body.theme_slug, "path": body.path,
            "new_version": theme.version,
            "new_signature": engine.version_signature(theme),
            "cache_invalidated_scopes": impact["invalidated_cache_scopes"],
            "impact": impact, "confirmations_needs_rereview": rereview}


def _set_dotted(obj, path, value):
    parts = path.split(".")
    cur = obj
    for p in parts[:-1]:
        cur = cur.setdefault(p, {})
    cur[parts[-1]] = value


# ---------------------------------------------------------- compare colors
@app.post("/api/compare")
def compare(body: CompareRequest):
    results = []
    for fg, bg in body.pairs:
        r = contrast_pair(fg, bg, scale=body.scale, purpose=body.purpose)
        results.append(r)
    return {"results": results}


@app.get("/api/color/parse")
def color_parse(value: str):
    try:
        return {"input": value, "legal": True, "rgba": parse_color(value)}
    except ColorError as e:
        return {"input": value, "legal": False, "error": str(e)}


# ------------------------------------------------------------- components
@app.get("/api/components")
def components(db: Session = Depends(get_db)):
    out = []
    deps = {(d.component_id, d.depends_on_id)
            for d in db.query(ComponentDependency).all()}
    for c in db.query(Component).order_by(Component.id).all():
        depends = [db.get(Component, did).slug
                   for (cid, did) in deps if cid == c.id]
        dependents = [db.get(Component, cid).slug
                      for (cid, did) in deps if did == c.id]
        out.append({"id": c.id, "slug": c.slug, "name": c.name,
                    "kind": c.kind, "supported_tokens": c.supported_tokens,
                    "required_token_paths": c.required_token_paths,
                    "states": c.states, "depends_on": depends,
                    "dependents": dependents})
    return out


@app.get("/api/components/{slug}/rendered")
def component_rendered(slug: str, db: Session = Depends(get_db)):
    """Live preview data: for every state/theme, resolve the actual token
    values and compute the contrast bound to that usage state."""
    c = db.query(Component).filter_by(slug=slug).one_or_none()
    if not c:
        raise HTTPException(404, "unknown component")
    engine = TokenEngine(db)
    previews = []
    for state, usage in (c.states or {}).items():
        for theme in db.query(Theme).order_by(Theme.id).all():
            exp = engine.static_expand(theme)
            vals = {}
            for role in ("foreground", "background", "font_size",
                         "font_weight", "icon_color"):
                p = usage.get(role)
                if p:
                    node = exp["tokens"].get(p, {})
                    vals[role] = {"path": p, "value": node.get("value"),
                                  "winner": (node.get("winner") or {}).get("theme_slug")}
            if usage.get("icon_color_literal") is not None:
                vals["icon_color"] = {"path": None,
                                      "value": usage["icon_color_literal"],
                                      "winner": "<hard-coded>"}
            pair = None
            if usage.get("text_used") and not (
                    usage.get("disabled") or state == "disabled") \
                    and "foreground" in vals and "background" in vals:
                pair = contrast_pair(vals["foreground"]["value"],
                                     vals["background"]["value"], purpose="text")
            previews.append({"state": state, "theme_slug": theme.slug,
                             "disabled": bool(usage.get("disabled")
                                              or state == "disabled"),
                             "values": vals, "contrast": pair})
    return {"component": c.slug, "states": c.states, "previews": previews}


@app.get("/api/dependencies")
def dependencies(db: Session = Depends(get_db)):
    edges = []
    for d in db.query(ComponentDependency).all():
        edges.append({"from": db.get(Component, d.component_id).slug,
                      "to": db.get(Component, d.depends_on_id).slug,
                      "version_bound": d.version_bound})
    return {"edges": edges}


# ------------------------------------------------------------ screenshots
@app.post("/api/screenshots")
def create_screenshot(body: ScreenshotCreate, db: Session = Depends(get_db)):
    c = db.query(Component).filter_by(slug=body.component_slug).one_or_none()
    if not c:
        raise HTTPException(404, "unknown component")
    if body.state not in (c.states or {}):
        raise HTTPException(422, f"unknown state {body.state}")
    if body.theme_slug not in {t.slug for t in db.query(Theme).all()}:
        raise HTTPException(422, "unknown theme")

    task = None
    if body.resume:
        task = db.query(ScreenshotTask).filter_by(
            component_id=c.id, theme_slug=body.theme_slug,
            state=body.state).order_by(ScreenshotTask.id.desc()).first()
    if task is None:
        task = ScreenshotTask(component_id=c.id, theme_slug=body.theme_slug,
                              state=body.state, status="pending",
                              design_version=_latest_version(db))
        db.add(task)
        db.flush()
    run_task(db, task.id, fail_before_step=body.fail_before_step)
    db.refresh(task)
    return _task_dict(task)


@app.get("/api/screenshots")
def list_screenshots(db: Session = Depends(get_db)):
    tasks = db.query(ScreenshotTask).order_by(ScreenshotTask.id).all()
    comps = {c.id: c.slug for c in db.query(Component).all()}
    return [{**_task_dict(t), "component_slug": comps.get(t.component_id)}
            for t in tasks]


def _task_dict(t):
    return {"id": t.id, "component_id": t.component_id,
            "theme_slug": t.theme_slug, "state": t.state,
            "status": t.status, "fail_step": t.fail_step, "error": t.error,
            "artifact_path": t.artifact_path,
            "token_version_hash": t.token_version_hash,
            "design_version": t.design_version,
            "attempted_at": t.attempted_at.isoformat() if t.attempted_at else None,
            "completed_at": t.completed_at.isoformat() if t.completed_at else None}


@app.get("/api/screenshots/{task_id}/artifact")
def screenshot_artifact(task_id: int, db: Session = Depends(get_db)):
    t = db.get(ScreenshotTask, task_id)
    if not t or not t.artifact_path:
        raise HTTPException(404, "no artifact")
    path = SCREENSHOT_DIR / t.artifact_path
    if not path.exists():
        raise HTTPException(410, "artifact missing on disk")
    return PlainTextResponse(path.read_text(encoding="utf-8"),
                             media_type="image/svg+xml")


# ----------------------------------------------------------- confirmations
@app.get("/api/confirmations")
def list_confirmations(db: Session = Depends(get_db)):
    comps = {c.id: c.slug for c in db.query(Component).all()}
    return [{"id": x.id, "component_slug": comps.get(x.component_id),
             "theme_slug": x.theme_slug, "state": x.state,
             "designer": x.designer, "status": x.status,
             "confirmed_token_hash": x.confirmed_token_hash,
             "current_token_hash": x.current_token_hash,
             "screenshot_id": x.screenshot_id, "note": x.note,
             "confirmed_at": x.confirmed_at.isoformat()}
            for x in db.query(Confirmation).order_by(Confirmation.id).all()]


@app.post("/api/confirmations")
def create_confirmation(body: ConfirmationCreate, db: Session = Depends(get_db)):
    """Designer confirms based on a concrete screenshot + the token version
    it was rendered with (not 'the current design' abstractly)."""
    c = db.query(Component).filter_by(slug=body.component_slug).one_or_none()
    if not c:
        raise HTTPException(404, "unknown component")
    shot = db.query(ScreenshotTask).filter_by(
        component_id=c.id, theme_slug=body.theme_slug,
        state=body.state, status="completed").order_by(
        ScreenshotTask.id.desc()).first()
    if not shot:
        raise HTTPException(422, "no completed screenshot to confirm against")
    engine = TokenEngine(db)
    theme = engine.theme_by_slug(body.theme_slug)
    sig = engine.version_signature(theme)
    shot_hash = shot.token_version_hash or sig
    # Confirmation is only valid when the concrete screenshot was rendered with
    # the current token version; otherwise it stays "needs_rereview".
    fresh = shot_hash == sig
    new_status = "confirmed" if fresh else "needs_rereview"
    conf = db.query(Confirmation).filter_by(
        component_id=c.id, theme_slug=body.theme_slug, state=body.state,
        designer=body.designer).one_or_none()
    if conf:
        conf.status = new_status
        conf.confirmed_token_hash = shot_hash
        conf.current_token_hash = sig
        conf.screenshot_id = shot.id
    else:
        conf = Confirmation(component_id=c.id, theme_slug=body.theme_slug,
                            state=body.state, designer=body.designer,
                            status=new_status,
                            confirmed_token_hash=shot_hash,
                            current_token_hash=sig, screenshot_id=shot.id)
        db.add(conf)
    _audit(db, "confirmation.create",
           {"component": body.component_slug, "theme": body.theme_slug,
            "state": body.state, "designer": body.designer,
            "screenshot_id": shot.id, "hash": shot_hash,
            "screenshot_fresh": fresh})
    db.commit()
    return {"confirmed": fresh, "status": new_status,
            "screenshot_id": shot.id, "token_hash": shot_hash,
            "current_token_hash": sig,
            "message": "确认已记录" if fresh else
            "截图基于旧令牌版本，仍需基于当前版本重新截图后复查"}


# ---------------------------------------------------------------- reports
@app.post("/api/reports")
def create_report(body: ReportCreate, db: Session = Depends(get_db)):
    """Kick off a background report; clients poll GET /api/reports/{id}."""
    report = CheckReport(design_version=body.design_version
                         or _latest_version(db), status="pending")
    db.add(report)
    db.commit()
    report_id = report.id

    def _worker():
        worker_db = SessionLocalFactory()
        try:
            run_report(worker_db, report_id)
        finally:
            worker_db.close()

    threading.Thread(target=_worker, daemon=True).start()
    return {"report_id": report_id, "status": "pending"}


@app.get("/api/reports/{report_id}")
def get_report(report_id: int, db: Session = Depends(get_db)):
    r = db.get(CheckReport, report_id)
    if not r:
        raise HTTPException(404, "no report")
    return {"id": r.id, "design_version": r.design_version,
            "status": r.status, "summary": r.summary,
            "findings": r.findings,
            "generated_at": r.generated_at.isoformat() if r.generated_at else None}


@app.get("/api/reports")
def list_reports(db: Session = Depends(get_db)):
    return [{"id": r.id, "status": r.status,
             "design_version": r.design_version, "summary": r.summary,
             "created_at": r.created_at.isoformat()}
            for r in db.query(CheckReport).order_by(CheckReport.id.desc()).all()]


# ------------------------------------------------------- design versions
@app.get("/api/versions")
def versions(db: Session = Depends(get_db)):
    return [{"version": v.version, "note": v.note,
             "created_at": v.created_at.isoformat(),
             "theme_signatures": {s: d["signature"] for s, d in
                                  (v.snapshot or {}).get("themes", {}).items()}}
            for v in db.query(DesignVersion).order_by(DesignVersion.id).all()]


@app.post("/api/versions/freeze")
def freeze_version(body: FreezeVersion, db: Session = Depends(get_db)):
    if db.query(DesignVersion).filter_by(version=body.version).first():
        raise HTTPException(409, "version exists")
    engine = TokenEngine(db)
    snapshot = {"themes": {}}
    for t in db.query(Theme).all():
        exp = engine.static_expand(t, force=True)
        snapshot["themes"][t.slug] = {
            "signature": exp["signature"],
            "tokens": {p: n["value"] for p, n in exp["tokens"].items()}}
    v = DesignVersion(version=body.version, snapshot=snapshot, note=body.note,
                      created_by="api")
    db.add(v)
    _audit(db, "version.freeze", {"version": body.version})
    db.commit()
    return {"version": body.version, "snapshot_themes": list(snapshot["themes"])}


@app.get("/api/versions/{version}")
def get_version(version: str, db: Session = Depends(get_db)):
    v = db.query(DesignVersion).filter_by(version=version).one_or_none()
    if not v:
        raise HTTPException(404, "no such frozen version")
    return v.snapshot


# -------------------------------------------------------- annotated export
@app.get("/api/export/{component_slug}/{theme_slug}/{state}")
def export_annotation(component_slug: str, theme_slug: str, state: str,
                      db: Session = Depends(get_db)):
    try:
        return annotated_export(db, component_slug, theme_slug, state)
    except Exception as e:
        raise HTTPException(422, str(e))


@app.get("/api/audit")
def audit(limit: int = 50, db: Session = Depends(get_db)):
    rows = db.query(AuditEvent).order_by(AuditEvent.id.desc()).limit(limit).all()
    return [{"id": r.id, "kind": r.kind, "payload": r.payload,
             "created_at": r.created_at.isoformat()} for r in rows]


def _latest_version(db):
    v = db.query(DesignVersion).order_by(DesignVersion.id.desc()).first()
    return v.version if v else None


# ---------------------------------------------------------------- frontend
@app.get("/", response_class=HTMLResponse)
def index():
    return (BASE_DIR / "frontend" / "index.html").read_text(encoding="utf-8")


app.mount("/static", StaticFiles(directory=str(BASE_DIR / "frontend")),
          name="static")
app.mount("/screenshots", StaticFiles(directory=str(SCREENSHOT_DIR)),
          name="screenshots")


# Session factory usable from background worker threads
from .db import SessionLocal as SessionLocalFactory  # noqa: E402
