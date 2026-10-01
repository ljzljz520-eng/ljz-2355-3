"""Color parsing + WCAG 2.x contrast utilities.

A syntactically legal color is not enough: readability is a property of a
*pair* used in a concrete state, hence ``contrast_pair`` takes both the
foreground and background and returns the ratio plus the AA level that passes.
"""
import re

from .config import RATIO_AA_LARGE, RATIO_AA_NORMAL, RATIO_AA_UI

_HEX = re.compile(r"^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
_RGB = re.compile(r"rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$")


class ColorError(ValueError):
    pass


def parse_color(value):
    """Return (r, g, b, a) with 0-255 rgb channels and 0..1 alpha."""
    if value is None:
        raise ColorError("empty color")
    v = value.strip()
    m = _HEX.match(v)
    if m:
        h = m.group(1)
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
        a = int(h[6:8], 16) / 255 if len(h) == 8 else 1.0
        return r, g, b, a
    m = _RGB.match(v)
    if m:
        r, g, b = (int(float(m.group(i))) for i in (1, 2, 3))
        a = float(m.group(4)) if m.group(4) is not None else 1.0
        for ch in (r, g, b):
            if not 0 <= ch <= 255:
                raise ColorError(f"channel out of range in {value!r}")
        if not 0 <= a <= 1:
            raise ColorError(f"alpha out of range in {value!r}")
        return r, g, b, a
    raise ColorError(f"unsupported color syntax: {value!r}")


def is_legal(value) -> bool:
    try:
        parse_color(value)
        return True
    except (ColorError, TypeError, AttributeError):
        return False


def _rel_lum(rgb):
    def chan(c):
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = rgb
    return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)


def flatten_over(rgba, rgba_bg=(255, 255, 255, 1.0)):
    """Alpha-composite a color over an opaque backdrop for ratio purposes."""
    r, g, b, a = rgba
    br, bg, bb, _ = rgba_bg
    return (
        round(r * a + br * (1 - a)),
        round(g * a + bg * (1 - a)),
        round(b * a + bb * (1 - a)),
    )


def contrast_ratio(fg, bg):
    """WCAG contrast ratio for two parseable color values (>=1, <=21)."""
    fr, fg_, fb, fa = parse_color(fg)
    br, bg_, bb, ba = parse_color(bg)
    # Composite back layer over white first, then front over that.
    back = flatten_over((br, bg_, bb, ba))
    front = flatten_over((fr, fg_, fb, fa), (back[0], back[1], back[2], 1.0))
    l1, l2 = _rel_lum(front), _rel_lum(back)
    lighter, darker = max(l1, l2), min(l1, l2)
    return round((lighter + 0.05) / (darker + 0.05), 2)


def passes_aa(ratio, scale="normal", purpose="text"):
    """AA thresholds. UI components/graphics and large text use 3:1."""
    threshold = RATIO_AA_NORMAL
    if purpose == "ui" or scale == "large":
        threshold = RATIO_AA_LARGE if scale == "large" else RATIO_AA_UI
    return ratio >= threshold, threshold


def contrast_pair(fg, bg, scale="normal", purpose="text"):
    """Full result for a concrete foreground/background usage."""
    legal = is_legal(fg) and is_legal(bg)
    if not legal:
        return {
            "foreground": fg, "background": bg, "legal": False, "ratio": None,
            "passes": False, "threshold": None,
            "reason": "one or both colors are not legal values",
        }
    ratio = contrast_ratio(fg, bg)
    passes, threshold = passes_aa(ratio, scale=scale, purpose=purpose)
    return {
        "foreground": fg, "background": bg, "legal": True, "ratio": ratio,
        "passes": passes, "threshold": threshold, "scale": scale,
        "purpose": purpose,
        "reason": f"{ratio}:1 vs required {threshold}:1",
    }
