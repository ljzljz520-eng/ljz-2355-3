"""Seed a brand + theme inheritance graph, tokens (incl. an alias cycle),
components with real state usage, dependencies, design version, screenshot
tasks (one interrupted, one pending) and designer confirmations (one stale)."""
from . import models
from .db import SessionLocal, init_db
from .models import (
    Brand, Component, ComponentDependency, ComponentVersionSupport,
    Confirmation, DesignVersion, ScreenshotTask, Theme,
)
from .screenshots import run_task
from .tokens import TokenEngine


def _tok(value, type_=None):
    return {"value": value, "type": type_} if type_ else {"value": value}


BASE_TOKENS = {
    "color": {
        "palette": {
            "grey": {"50": _tok("#f9fafb"), "100": _tok("#f3f4f6"),
                     "200": _tok("#e5e7eb"), "500": _tok("#6b7280"),
                     "700": _tok("#374151"), "900": _tok("#111827")},
            "blue": {"500": _tok("#2563eb"), "600": _tok("#1d4ed8"),
                     "400": _tok("#60a5fa")},
        },
        "brand": {
            "primary": _tok("{color.palette.blue.600}", "color"),
            "primary_strong": _tok("{color.palette.blue.500}", "color"),
            "on_primary": _tok("#ffffff", "color"),
        },
        "text": {
            "strong": _tok("{color.palette.grey.900}", "color"),
            "subtle": _tok("{color.palette.grey.500}", "color"),
        },
        "surface": {
            "base": _tok("#ffffff", "color"),
            "muted": _tok("{color.palette.grey.100}", "color"),
        },
        "border": {"strong": _tok("{color.palette.grey.200}", "color")},
        "danger": {"surface": _tok("#fef2f2", "color"),
                   "text": _tok("#b91c1c", "color")},
        "icon": {"default": _tok("{color.palette.grey.700}", "color")},
        "focus": {"ring": _tok("{color.palette.blue.500}", "color")},
    },
    "font": {
        "size": {"sm": _tok("12px", "fontSize"), "md": _tok("14px", "fontSize"),
                 "lg": _tok("18px", "fontSize"), "xl": _tok("24px", "fontSize")},
        "weight": {"regular": _tok("400", "fontWeight"),
                   "bold": _tok("700", "fontWeight")},
    },
    "radius": {"md": _tok("6px", "radius")},
    "spacing": {"md": _tok("8px", "spacing")},
}

LIGHT_TOKENS = {
    "color": {
        "brand": {"primary": _tok("#1d4ed8", "color"),
                  "primary_strong": _tok("#1e40af", "color"),
                  "on_primary": _tok("#ffffff", "color")},
        "surface": {"base": _tok("#ffffff", "color"),
                    "muted": _tok("#f3f4f6", "color")},
        # Legal color but too light on white (~2.9:1) -> fails AA 4.5:1 in any
        # state that actually renders helper text. Demonstrates that "valid
        # value" != "readable combination".
        "text": {"strong": _tok("#111827", "color"),
                 "subtle": _tok("#9ca3af", "color")},
        "border": {"strong": _tok("#d1d5db", "color")},
        "danger": {"surface": _tok("#fef2f2", "color"),
                   "text": _tok("#b91c1c", "color")},
        "icon": {"default": _tok("#374151", "color")},
        "focus": {"ring": _tok("#2563eb", "color")},
    },
    "font": {"size": {"md": _tok("14px", "fontSize")}},
}

DARK_TOKENS = {
    "color": {
        "brand": {"primary": _tok("#3b82f6", "color"),
                  "on_primary": _tok("#0b1220", "color")},
        "surface": {"base": _tok("#111827", "color"),
                    "muted": _tok("#1f2937", "color")},
        "text": {"strong": _tok("#f9fafb", "color"),
                 "subtle": _tok("#9ca3af", "color")},
        # NOTE: color.border.strong deliberately NOT overridden -> theme
        # override gap for InputField.
        "danger": {"surface": _tok("#3f1d1d", "color"),
                   "text": _tok("#fca5a5", "color")},
        "icon": {"default": _tok("#d1d5db", "color")},
        "focus": {"ring": _tok("#60a5fa", "color")},
    },
}

EXPERIMENTAL_TOKENS = {
    "color": {
        "brand": {
            # alias ring: primary -> accent; accent -> primary
            "primary": _tok("{color.brand.accent}", "color"),
            "accent": _tok("{color.brand.primary}", "color"),
        },
    },
}


COMPONENTS = [
    {
        "slug": "button-primary", "name": "主按钮", "kind": "button",
        "supported_tokens": [
            "color.brand.primary", "color.brand.on_primary",
            "color.surface.muted", "color.text.subtle",
            "color.focus.ring",
            "font.size.lg", "font.weight.bold", "radius.md"],
        "required_token_paths": ["color.brand.primary",
                                 "color.brand.on_primary"],
        "states": {
            "default": {"text_used": True, "foreground": "color.brand.on_primary",
                        "background": "color.brand.primary",
                        "font_size": "font.size.lg",
                        "font_weight": "font.weight.bold",
                        "icon_color": "color.brand.on_primary",
                        "note": "品牌主操作"},
            "disabled": {"text_used": True, "disabled": True,
                         "foreground": "color.text.subtle",
                         "background": "color.surface.muted",
                         "font_size": "font.size.lg",
                         "font_weight": "font.weight.bold",
                         "note": "禁用态：豁免对比度，不计为合格演示"},
        },
    },
    {
        "slug": "input-field", "name": "输入框", "kind": "form",
        "supported_tokens": [
            "color.surface.base", "color.text.strong", "color.text.subtle",
            "color.danger.surface", "color.danger.text",
            "color.border.strong", "color.icon.default", "color.focus.ring",
            "font.size.sm", "font.size.md", "font.weight.regular"],
        "required_token_paths": ["color.surface.base", "color.text.strong",
                                 "color.border.strong", "color.text.subtle",
                                 "color.danger.surface", "color.danger.text",
                                 "color.icon.default"],
        "states": {
            "default": {"text_used": True, "foreground": "color.text.strong",
                        "background": "color.surface.base",
                        "font_size": "font.size.md",
                        "font_weight": "font.weight.regular",
                        "icon_color": "color.icon.default"},
            "helper": {"text_used": True, "foreground": "color.text.subtle",
                       "background": "color.surface.base",
                       "font_size": "font.size.sm",
                       "font_weight": "font.weight.regular",
                       "note": "辅助说明文字，light 主题下对比度不足"},
            "error": {"text_used": True, "foreground": "color.danger.text",
                      "background": "color.danger.surface",
                      "font_size": "font.size.sm",
                      "font_weight": "font.weight.regular",
                      "icon_color": "color.danger.text",
                      "note": "错误提示"},
            "disabled": {"text_used": True, "disabled": True,
                         "foreground": "color.text.subtle",
                         "background": "color.surface.muted",
                         "font_size": "font.size.md",
                         "font_weight": "font.weight.regular"},
        },
    },
    {
        "slug": "icon-button", "name": "图标按钮", "kind": "icon",
        "supported_tokens": ["color.surface.base", "color.icon.default",
                             "color.focus.ring"],
        "required_token_paths": [],
        "states": {
            "default": {"text_used": False,
                        "background": "color.surface.base",
                        # hard-coded color: cannot follow theme; also ~2.85:1
                        # on white, below 3:1 UI contrast.
                        "icon_color_literal": "#999999",
                        "note": "动态图标颜色被硬编码"},
            "disabled": {"text_used": False, "disabled": True,
                         "background": "color.surface.muted",
                         "icon_color_literal": "#cccccc"},
        },
    },
    {
        "slug": "legacy-card", "name": "旧版卡片", "kind": "card",
        # Never adopted the newly introduced focus token.
        "supported_tokens": ["color.surface.base", "color.text.strong",
                             "font.size.md", "font.weight.regular"],
        "required_token_paths": [],
        "states": {
            "default": {"text_used": True, "foreground": "color.text.strong",
                        "background": "color.surface.base",
                        "font_size": "font.size.md",
                        "font_weight": "font.weight.regular"},
        },
    },
]

DEPENDENCIES = [
    ("button-primary", "icon-button"),
    ("input-field", "icon-button"),
]


def seed(recreate=True):
    init_db()
    db = SessionLocal()
    try:
        if recreate:
            for m in [Confirmation, ScreenshotTask, ComponentDependency,
                      ComponentVersionSupport, Component, DesignVersion,
                      Theme, Brand, models.AuditEvent, models.CheckReport]:
                db.query(m).delete()
            db.commit()

        brand = Brand(name="Acme 品牌", slug="acme")
        db.add(brand)
        db.flush()

        base = Theme(brand_id=brand.id, name="基础基元", slug="base",
                     parent_id=None, tokens=BASE_TOKENS, version=3)
        db.add(base)
        db.flush()
        light = Theme(brand_id=brand.id, name="浅色", slug="light",
                      parent_id=base.id, tokens=LIGHT_TOKENS, version=2)
        dark = Theme(brand_id=brand.id, name="深色", slug="dark",
                     parent_id=base.id, tokens=DARK_TOKENS, version=2)
        db.add_all([light, dark])
        db.flush()
        experimental = Theme(brand_id=brand.id, name="实验主题",
                             slug="experimental", parent_id=base.id,
                             tokens=EXPERIMENTAL_TOKENS, version=1)
        db.add(experimental)
        db.commit()

        comps = {}
        for spec in COMPONENTS:
            c = Component(name=spec["name"], slug=spec["slug"],
                          kind=spec["kind"],
                          supported_tokens=spec["supported_tokens"],
                          states=spec["states"],
                          required_token_paths=spec["required_token_paths"])
            db.add(c)
            comps[spec["slug"]] = c
        db.flush()
        for src, dst in DEPENDENCIES:
            db.add(ComponentDependency(component_id=comps[src].id,
                                       depends_on_id=comps[dst].id,
                                       version_bound="v2026.1"))
        for c in comps.values():
            db.add(ComponentVersionSupport(component_id=c.id,
                                           design_version="v2026.1",
                                           supports_version=True))
        db.commit()

        # Freeze a design version with the fully expanded token map.
        engine = TokenEngine(db)
        snapshot = {"themes": {}, "introduced_tokens": ["color.focus.ring"]}
        for t in db.query(Theme).all():
            exp = engine.static_expand(t, force=True)
            snapshot["themes"][t.slug] = {
                "signature": exp["signature"],
                "tokens": {p: {"value": n["value"],
                               "winner": (n["winner"] or {}).get("theme_slug")}
                           for p, n in exp["tokens"].items()},
            }
        dv = DesignVersion(version="v2026.1", snapshot=snapshot,
                           created_by="system", note="初始冻结版本")
        db.add(dv)
        db.commit()

        def new_task(comp_slug, theme_slug, state, status=None,
                     fail_step=None):
            task = ScreenshotTask(component_id=comps[comp_slug].id,
                                  theme_slug=theme_slug, state=state,
                                  design_version="v2026.1")
            db.add(task)
            db.flush()
            return task

        # Completed, provenance-bearing screenshots.
        for spec in [("button-primary", "light", "default", None),
                     ("button-primary", "dark", "default", None),
                     ("input-field", "light", "default", None)]:
            t = new_task(*spec)
            db.commit()
            run_task(db, t.id)

        # Interrupted screenshot task (must be detected + resumable).
        interrupted = new_task("input-field", "dark", "helper")
        db.commit()
        run_task(db, interrupted.id, fail_before_step="render")

        # Never-finished pending task.
        new_task("icon-button", "light", "default", status="pending")
        db.commit()

        # Confirmations -----------------------------------------------------
        light_sig = engine.version_signature(light)
        btn_shot = db.query(ScreenshotTask).filter_by(
            component_id=comps["button-primary"].id, theme_slug="light",
            state="default").first()
        input_shot = db.query(ScreenshotTask).filter_by(
            component_id=comps["input-field"].id, theme_slug="light",
            state="default").first()

        # stale: confirmed against an older upstream token hash
        db.add(Confirmation(component_id=comps["button-primary"].id,
                            theme_slug="light", state="default",
                            designer="mina", status="confirmed",
                            confirmed_token_hash="older-hash-aaaa1111",
                            current_token_hash=light_sig,
                            screenshot_id=btn_shot.id if btn_shot else None,
                            note="上游品牌色已更新，待复查"))
        # current
        db.add(Confirmation(component_id=comps["input-field"].id,
                            theme_slug="light", state="default",
                            designer="roy", status="confirmed",
                            confirmed_token_hash=light_sig,
                            current_token_hash=light_sig,
                            screenshot_id=input_shot.id if input_shot else None))
        db.commit()
        return {"ok": True}
    finally:
        db.close()


if __name__ == "__main__":
    print(seed())
