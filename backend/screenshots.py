"""Component screenshot tasks and annotated design-icon export.

Screenshots are rendered as SVG (viewable/exportable) and carry provenance:
component, theme, state, the resolved token values used, the token version
hash and the design version. A task executes in discrete steps so that an
interruption is detectable, resumable, and never silently looks completed.
"""
import json
from datetime import datetime, timezone
from xml.sax.saxutils import escape

from .colorutils import is_legal
from .config import SCREENSHOT_DIR
from .models import Component, ScreenshotTask
from .tokens import TokenEngine

# steps that can be interrupted; tests can force a failure at any of them
TASK_STEPS = ["acquire", "resolve_tokens", "render", "persist"]


def render_svg(component, state, usage, values, width=360, height=140):
    """values: resolved {token_path: value} for this theme."""
    bg = values.get(usage.get("background", ""), "#ffffff")
    fg = values.get(usage.get("foreground", ""), "#111111")
    font = values.get(usage.get("font_size", ""), "14px")
    icon_color = values.get(usage.get("icon_color", ""),
                            usage.get("icon_color_literal", "#666666"))
    if not is_legal(bg):
        bg = "#ffffff"
    if not is_legal(fg):
        fg = "#111111"
    label = f"{component.name} · {state}"
    disabled = usage.get("disabled", False) or state == "disabled"
    badge = "DISABLED" if disabled else state.upper()
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
  <rect width="100%" height="100%" rx="10" fill="{bg}"/>
  <circle cx="34" cy="70" r="14" fill="none" stroke="{icon_color}" stroke-width="3"/>
  <text x="60" y="62" font-family="system-ui, sans-serif" font-size="{font}" fill="{fg}">{escape(label)}</text>
  <text x="60" y="88" font-family="system-ui, sans-serif" font-size="12" fill="{fg}" opacity="{0.5 if disabled else 0.85}">{badge}</text>
</svg>'''


def run_task(db, task_id, fail_before_step=None):
    """Execute (or resume) a screenshot task.

    fail_before_step: if set, interrupt immediately before that step. Resumed
    tasks start after the last completed step.
    """
    task = db.get(ScreenshotTask, task_id)
    engine = TokenEngine(db)
    component = db.get(Component, task.component_id)
    usage = (component.states or {}).get(task.state, {})

    done_steps = []
    if task.status == "interrupted" and task.fail_step:
        # resume from the failed step
        start = TASK_STEPS.index(task.fail_step) if task.fail_step in TASK_STEPS else 0
    else:
        start = 0
    task.status = "running"
    db.commit()

    resolved_values = {}
    try:
        for step in TASK_STEPS[start:]:
            if fail_before_step == step:
                task.status = "interrupted"
                task.fail_step = step
                task.error = f"interrupted before step '{step}'"
                task.attempted_at = datetime.now(timezone.utc)
                db.commit()
                return task
            if step == "acquire":
                done_steps.append(step)
            elif step == "resolve_tokens":
                exp = engine.static_expand(engine.theme_by_slug(task.theme_slug))
                for p in set(filter(None, [usage.get("background"),
                                           usage.get("foreground"),
                                           usage.get("font_size"),
                                           usage.get("font_weight"),
                                           usage.get("icon_color")])):
                    node = exp["tokens"].get(p)
                    resolved_values[p] = node.get("value") if node else None
                task.token_version_hash = exp["signature"]
                done_steps.append(step)
            elif step == "render":
                svg = render_svg(component, task.state, usage, resolved_values)
                done_steps.append(step)
            elif step == "persist":
                fname = f"{component.slug}__{task.theme_slug}__{task.state}.svg"
                path = SCREENSHOT_DIR / fname
                meta = {
                    "component": component.slug, "theme": task.theme_slug,
                    "state": task.state,
                    "token_version_hash": task.token_version_hash,
                    "design_version": task.design_version,
                    "resolved_values": resolved_values,
                }
                path.write_text(
                    svg.replace("</svg>",
                                _provenance_marker(meta) + "\n</svg>"),
                    encoding="utf-8")
                # filename only; the serving route joins it with the
                # configured SCREENSHOT_DIR, so tests can redirect artifacts
                # to a tmpdir
                task.artifact_path = fname
                task.status = "completed"
                task.fail_step = None
                task.error = None
                task.completed_at = datetime.now(timezone.utc)
                done_steps.append(step)
        db.commit()
    except Exception as exc:  # pragma: no cover - defensive
        task.status = "failed"
        task.error = str(exc)
        db.commit()
    return task


def _provenance_marker(meta):
    payload = escape(json.dumps(meta, ensure_ascii=False))
    return (f'  <metadata id="design-provenance" '
            f'data-source="design-token-service">{payload}</metadata>')


def annotated_export(db, component_slug, theme_slug, state):
    """Produce an annotated design icon whose labels are traceable to the
    source token path, resolved value, and winning theme layer."""
    component = db.query(Component).filter_by(slug=component_slug).one()
    engine = TokenEngine(db)
    exp = engine.static_expand(engine.theme_by_slug(theme_slug))
    usage = (component.states or {}).get(state, {})
    annotations = []
    for role, p in (("background", usage.get("background")),
                    ("foreground", usage.get("foreground")),
                    ("icon_color", usage.get("icon_color")),
                    ("font_size", usage.get("font_size"))):
        if not p:
            continue
        node = exp["tokens"].get(p, {})
        annotations.append({
            "role": role, "token_path": p,
            "resolved_value": node.get("value"),
            "winner_theme": (node.get("winner") or {}).get("theme_slug"),
            "override_priority": node.get("override_priority"),
        })

    values = {a["token_path"]: a["resolved_value"] for a in annotations}
    svg = render_svg(component, state, usage, values, width=420, height=180)
    notes = "\n".join(
        f'  <!-- @source role={a["role"]} token={a["token_path"]} '
        f'value={a["resolved_value"]} winner={a["winner_theme"]} -->'
        for a in annotations)
    meta = _provenance_marker({
        "component": component.slug, "theme": theme_slug, "state": state,
        "token_version_hash": exp["signature"], "annotations": annotations})
    svg = svg.replace("</svg>", notes + "\n" + meta + "\n</svg>")
    return {"component": component.slug, "theme": theme_slug,
            "state": state, "signature": exp["signature"],
            "annotations": annotations, "svg": svg}
