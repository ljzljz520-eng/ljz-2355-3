"""Background design check report.

Rule catalogue (each finding carries evidence so the UI can trace it):
* alias_cycle            - alias token references form a cycle
* theme_override_gap     - leaf theme omits an override the component contract needs
* contrast_state         - real fg/bg pair used in a concrete state fails WCAG
* disabled_demo          - disabled example must never count as a passing demo
* dynamic_icon_color     - icon color hard-coded/unresolved or fails 3:1
* legacy_component_token - old component never adopted a newly introduced token
* screenshot_interrupted - screenshot task did not complete
* traceability           - completed screenshot / export lacks source metadata
* stale_confirmation     - confirmation based on a token version now changed
"""
import re
from datetime import datetime, timezone

from .colorutils import contrast_pair, is_legal
from .models import (
    CheckReport, Component, Confirmation, DesignVersion, ScreenshotTask, Theme,
)
from .tokens import TokenEngine

SEV_ERROR = "error"
SEV_WARN = "warning"
SEV_INFO = "info"

PX = re.compile(r"([\d.]+)\s*px")


def _px(value):
    if value is None:
        return None
    m = PX.match(str(value).strip())
    return float(m.group(1)) if m else None


def _is_large(font_px, weight):
    if font_px is None:
        return False
    try:
        w = float(str(weight).rstrip("bold") or 400) if weight else 400
    except ValueError:
        w = 700 if weight == "bold" else 400
    return font_px >= 24 or (font_px >= 18.66 and w >= 700)


def _color_at(expansions, theme_slug, path):
    node = expansions.get(theme_slug, {}).get("tokens", {}).get(path)
    if not node:
        return None, f"token {path} not present in theme {theme_slug}"
    if not node.get("resolved"):
        return None, f"token {path} unresolved (cycle or missing reference)"
    val = node.get("value")
    if not is_legal(val):
        return None, f"token {path}={val!r} is not a legal color"
    return val, None


def generate_report(db, design_version=None):
    engine = TokenEngine(db)
    themes = db.query(Theme).order_by(Theme.id).all()
    components = db.query(Component).order_by(Component.id).all()

    dv = None
    if design_version:
        dv = db.query(DesignVersion).filter_by(version=design_version).one_or_none()
    if dv is None:
        dv = db.query(DesignVersion).order_by(DesignVersion.id.desc()).first()
    dv_version = dv.version if dv else None
    introduced = set((dv.snapshot or {}).get("introduced_tokens", [])) if dv else set()

    expansions = {t.slug: engine.static_expand(t) for t in themes}
    leaf_slugs = _leaf_theme_slugs(themes)
    # A theme with an alias cycle cannot be evaluated further: its values do
    # not resolve, so downstream checks are skipped (and the gap rule reports
    # exactly the unresolved token names rather than every inherited token).
    cyclic_slugs = {s for s, e in expansions.items() if e["cycles"]}

    findings = []

    def add(rule, severity, subject, message, **evidence):
        findings.append({"rule": rule, "severity": severity, "subject": subject,
                         "message": message, "evidence": evidence})

    # 1) alias cycles -------------------------------------------------------
    for slug, exp in expansions.items():
        for cyc in exp["cycles"]:
            add("alias_cycle", SEV_ERROR, f"theme:{slug}",
                "令牌引用形成环，无法解析：" + " → ".join(cyc),
                cycle=cyc, theme_slug=slug)

    # 2) theme override gaps (explicit per-theme declaration required) ------
    required_by_component = {}
    for c in components:
        for p in (c.required_token_paths or []):
            required_by_component.setdefault(p, []).append(c.slug)
    own_tokens = {t.slug: set(_own_flat(t)) for t in themes}
    for t in themes:
        if t.slug not in leaf_slugs:
            continue
        if t.slug in cyclic_slugs:
            # Override completeness is meaningless while the branch has an
            # unresolved alias cycle; the alias_cycle finding already blocks
            # release, so do not pile inherited-gap noise on this theme.
            continue
        for path, comps in sorted(required_by_component.items()):
            if path not in own_tokens[t.slug]:
                add("theme_override_gap", SEV_ERROR, f"theme:{t.slug}",
                    f"主题 {t.slug} 缺少必要覆盖 {path}（被 {', '.join(comps)} 使用）",
                    theme_slug=t.slug, missing=path, used_by=comps)

    # 3-6) component state checks ------------------------------------------
    healthy_themes = [t.slug for t in themes if t.slug not in cyclic_slugs]
    for c in components:
        _component_state_findings(add, c, expansions, healthy_themes,
                                  introduced)

    # 7) screenshot tasks ---------------------------------------------------
    for task in db.query(ScreenshotTask).all():
        if task.status in ("interrupted", "failed"):
            add("screenshot_interrupted", SEV_ERROR,
                f"screenshot:{task.id}",
                f"{task.theme_slug}/{task.state} 截图任务在步骤 "
                f"{task.fail_step or 'unknown'} 中断",
                task_id=task.id, component_id=task.component_id,
                theme_slug=task.theme_slug, state=task.state,
                fail_step=task.fail_step, error=task.error,
                resumable=True)
        elif task.status == "pending":
            add("screenshot_interrupted", SEV_WARN, f"screenshot:{task.id}",
                f"{task.theme_slug}/{task.state} 截图任务尚未完成（pending）",
                task_id=task.id, resumable=True)

    # 8) traceability -------------------------------------------------------
    for task in db.query(ScreenshotTask).filter_by(status="completed").all():
        missing = [k for k in ("artifact_path", "token_version_hash",
                               "design_version")
                   if not getattr(task, k)]
        if missing:
            add("traceability", SEV_ERROR, f"screenshot:{task.id}",
                "已完成截图缺少可追溯来源字段：" + ", ".join(missing),
                task_id=task.id, missing=missing)

    # 9) stale confirmations ------------------------------------------------
    for conf in db.query(Confirmation).all():
        if conf.status in ("needs_rereview", "confirmed") and \
                conf.current_token_hash and \
                conf.current_token_hash != conf.confirmed_token_hash:
            add("stale_confirmation", SEV_ERROR,
                f"confirmation:{conf.id}",
                f"设计师 {conf.designer} 对 {conf.theme_slug}/{conf.state} 的确认"
                "基于旧令牌版本，需要复查",
                confirmation_id=conf.id, designer=conf.designer,
                status=conf.status,
                confirmed_hash=conf.confirmed_token_hash,
                current_hash=conf.current_token_hash)

    summary = _summarize(findings)
    return {"design_version": dv_version, "findings": findings,
            "summary": summary}


def _own_flat(theme):
    from .tokens import _flatten
    return _flatten(theme.tokens or {}).keys()


def _leaf_theme_slugs(themes):
    parent_ids = {t.parent_id for t in themes if t.parent_id}
    return {t.slug for t in themes if t.id not in parent_ids}


def _component_state_findings(add, component, expansions, theme_slugs,
                              introduced_tokens):
    name = component.slug
    passing_text_demo = False
    has_text_state = False
    disabled_text_seen = False

    # 4) old component not supporting newly introduced token
    unsupported = sorted(p for p in introduced_tokens
                         if p not in (component.supported_tokens or []))
    for p in unsupported:
        add("legacy_component_token", SEV_ERROR, f"component:{name}",
            f"旧组件 {name} 未支持新令牌 {p}",
            component=name, token=p)

    for state, usage in (component.states or {}).items():
        disabled = usage.get("disabled", False) or state == "disabled"
        text_used = usage.get("text_used", False)
        bg_path = usage.get("background")
        fg_path = usage.get("foreground")
        font_path = usage.get("font_size")
        weight_path = usage.get("font_weight")
        icon_path = usage.get("icon_color")
        icon_literal = usage.get("icon_color_literal")

        for slug in theme_slugs:
            exp = expansions[slug]
            token = lambda p: exp["tokens"].get(p, {}).get("value") if p else None

            bg, bg_err = (_color_at(expansions, slug, bg_path)
                          if bg_path else (None, "no background token"))
            fg, fg_err = (_color_at(expansions, slug, fg_path)
                          if fg_path else (None, "no foreground token"))

            if icon_path or icon_literal:
                _icon_findings(add, name, state, slug, icon_path,
                               icon_literal, bg, bg_err, exp, component,
                               disabled)

            if not text_used:
                continue
            has_text_state = True
            if disabled:
                # Disabled text is exempt from contrast and is NEVER counted
                # as a passing demonstration.
                add("disabled_demo", SEV_INFO, f"component:{name}",
                    f"{name}/{state}@{slug} 为禁用态，对比度豁免，不计入合格演示",
                    component=name, state=state, theme_slug=slug,
                    exempt=True, counted_as_pass=False)
                disabled_text_seen = True
                continue

            if bg_err or fg_err:
                add("contrast_state", SEV_ERROR, f"component:{name}",
                    f"{name}/{state}@{slug} 无法计算文本对比度："
                    f"{fg_err or bg_err}",
                    component=name, state=state, theme_slug=slug,
                    foreground_path=fg_path, background_path=bg_path)
                continue

            font_px = _px(token(font_path))
            scale = "large" if _is_large(font_px, token(weight_path)) else "normal"
            result = contrast_pair(fg, bg, scale=scale, purpose="text")
            if result["passes"]:
                passing_text_demo = True
            else:
                add("contrast_state", SEV_ERROR, f"component:{name}",
                    f"{name}/{state}@{slug} 文本对比度 {result['ratio']}:1 "
                    f"低于 AA {result['threshold']}:1（实际使用状态，非示例假设）",
                    component=name, state=state, theme_slug=slug,
                    ratio=result["ratio"], threshold=result["threshold"],
                    foreground=fg, background=bg, foreground_path=fg_path,
                    background_path=bg_path, scale=scale)

    # 6) If the component shows text but every text-bearing state is disabled,
    # there is no valid readable demonstration. A disabled example must never
    # be (mis)counted as a passing demo, and an active failing state is already
    # reported separately above.
    enabled_text_states = [
        st for st, u in (component.states or {}).items()
        if u.get("text_used") and not (u.get("disabled", False) or st == "disabled")]
    if has_text_state and not enabled_text_states and disabled_text_seen:
        add("disabled_demo", SEV_ERROR, f"component:{name}",
            f"{name} 没有可演示的非禁用文本状态，禁用示例不得计为合格演示",
            component=name)
    elif has_text_state and not passing_text_demo and enabled_text_states \
            and disabled_text_seen:
        add("disabled_demo", SEV_ERROR, f"component:{name}",
            f"{name} 的启用态文本未通过对比度，不能用禁用示例充作合格演示",
            component=name)


def _icon_findings(add, name, state, slug, icon_path, icon_literal, bg,
                   bg_err, exp, component, disabled=False):
    if icon_literal is not None:
        # hard-coded color cannot respond to theme changes
        add("dynamic_icon_color", SEV_ERROR, f"component:{name}",
            f"{name}/{state}@{slug} 图标颜色被硬编码为 {icon_literal}，"
            "无法随主题动态切换",
            component=name, state=state, theme_slug=slug,
            literal=icon_literal, hardcoded=True)
        icon_val = icon_literal if is_legal(icon_literal) else None
    else:
        if icon_path not in (component.supported_tokens or []):
            add("dynamic_icon_color", SEV_ERROR, f"component:{name}",
                f"{name}/{state}@{slug} 使用图标令牌 {icon_path}，"
                "但组件契约未声明支持该令牌",
                component=name, state=state, theme_slug=slug,
                token=icon_path, undeclared=True)
        icon_val, err = _color_at({slug: exp}, slug, icon_path)
        if err:
            add("dynamic_icon_color", SEV_ERROR, f"component:{name}",
                f"{name}/{state}@{slug} 图标颜色无法解析：{err}",
                component=name, state=state, theme_slug=slug,
                token=icon_path)
            return
    if bg is None or icon_val is None or disabled:
        # Disabled graphics are exempt from contrast; they must never be used
        # as evidence that a dynamic icon is readable.
        return
    result = contrast_pair(icon_val, bg, purpose="ui")
    if not result["passes"]:
        add("dynamic_icon_color", SEV_ERROR, f"component:{name}",
            f"{name}/{state}@{slug} 图标与背景对比 {result['ratio']}:1 "
            f"低于 3:1",
            component=name, state=state, theme_slug=slug,
            ratio=result["ratio"], icon=icon_val, background=bg)


def _summarize(findings):
    by_rule = {}
    by_severity = {SEV_ERROR: 0, SEV_WARN: 0, SEV_INFO: 0}
    for f in findings:
        by_rule[f["rule"]] = by_rule.get(f["rule"], 0) + 1
        by_severity[f["severity"]] = by_severity.get(f["severity"], 0) + 1
    return {
        "total": len(findings),
        "by_severity": by_severity,
        "by_rule": by_rule,
        "pass": by_severity[SEV_ERROR] == 0,
    }


def run_report(db, report_id):
    """Background worker entry point."""
    report = db.get(CheckReport, report_id)
    report.status = "running"
    db.commit()
    try:
        result = generate_report(db, report.design_version or None)
        report.findings = result["findings"]
        report.summary = result["summary"]
        report.status = "completed"
        report.generated_at = datetime.now(timezone.utc)
    except Exception as exc:  # pragma: no cover - defensive
        report.status = "failed"
        report.findings = [{"rule": "engine", "severity": "error",
                            "message": str(exc)}]
        report.generated_at = datetime.now(timezone.utc)
    db.commit()
    return report
