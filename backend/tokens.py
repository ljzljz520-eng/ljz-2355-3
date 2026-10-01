"""Token service.

Responsibilities:
* resolve brand + theme inheritance (child overrides parent, root first)
* resolve tokens that reference other tokens (``{dotted.path}`` aliases)
* detect reference cycles (alias rings) and report the exact cycle path
* explain override priority (provenance chain for every resolved value)
* statically expand *every* theme (full materialised map) vs request-time
  inheritance-graph resolution of a single token
* version signatures + explicit cache invalidation and change-impact lists
"""
import hashlib
import json
import threading
import time
from collections import defaultdict

from .config import RESOLVE_CACHE_TTL_SECONDS
from .models import Component, Theme

REF_OPEN, REF_CLOSE = "{", "}"


class CycleError(Exception):
    def __init__(self, cycle):
        self.cycle = cycle
        super().__init__("token reference cycle: " + " -> ".join(cycle))


class ResolutionError(Exception):
    def __init__(self, message, path=None):
        self.path = path
        super().__init__(message)


def _flatten(d, prefix=""):
    """Flatten nested mapping into {dotted.path: raw_spec}. Lists are leaves."""
    out = {}
    for k, v in d.items():
        key = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict) and "value" not in v:
            out.update(_flatten(v, key))
        else:
            out[key] = v
    return out


def _spec_value(spec):
    """A token node is either a bare scalar or {'value': ..., 'type': ...}."""
    if isinstance(spec, dict) and "value" in spec:
        return spec.get("value"), spec.get("type")
    return spec, None


def _extract_refs(value):
    if not isinstance(value, str):
        return []
    out, i = [], 0
    while True:
        a = value.find(REF_OPEN, i)
        if a < 0:
            break
        b = value.find(REF_CLOSE, a + 1)
        if b < 0:
            break
        out.append(value[a + 1:b])
        i = b + 1
    return out


def _substitute(value, resolved):
    def repl(m):
        name = m.group(1)
        if name not in resolved:
            raise ResolutionError(f"unresolved reference {{{name}}}", path=name)
        return str(resolved[name])
    import re
    return re.sub(r"\{([^{}]+)\}", repl, value)


class _SharedCache:
    """Process-wide resolution cache shared across request-scoped engines.

    Validity is gated by the theme version signature, so stale data can never be
    served; explicit invalidation happens on every token write as well.
    """
    def __init__(self):
        self.lock = threading.RLock()
        self.expand = {}   # slug -> {"sig","ts","data"}
        self.resolve = {}  # (slug,path) -> {"sig","ts","data"}


_SHARED = _SharedCache()


class TokenEngine:
    def __init__(self, db, cache=None):
        self.db = db
        self._cache = cache if cache is not None else _SHARED
        self._lock = self._cache.lock
        self._expand_cache = self._cache.expand
        self._resolve_cache = self._cache.resolve

    # ---------- inheritance graph ----------
    def theme_by_slug(self, slug):
        return self.db.query(Theme).filter(Theme.slug == slug).one_or_none()

    def inheritance_chain(self, theme):
        """Return themes root -> leaf and detect inheritance cycles."""
        chain, seen, cur = [], set(), theme
        while cur is not None:
            if cur.id in seen:
                cyc = [t.slug for t in chain] + [cur.slug]
                raise CycleError(cyc)
            seen.add(cur.id)
            chain.append(cur)
            cur = self.db.get(Theme, cur.parent_id) if cur.parent_id else None
        return list(reversed(chain))

    def inheritance_graph(self):
        themes = self.db.query(Theme).order_by(Theme.id).all()
        nodes, edges = [], []
        for t in themes:
            nodes.append({"slug": t.slug, "name": t.name, "parent": None})
        by_id = {t.id: t for t in themes}
        for t in themes:
            if t.parent_id:
                edges.append({"from": by_id[t.parent_id].slug, "to": t.slug})
                for n in nodes:
                    if n["slug"] == t.slug:
                        n["parent"] = by_id[t.parent_id].slug
        return {"nodes": nodes, "edges": edges}

    def merged_layers(self, theme):
        """Return list of {theme_slug, tokens(flat)} root->leaf and the merged
        raw map plus a per-path provenance record for override priority."""
        chain = self.inheritance_chain(theme)
        layers = []
        merged = {}
        # provenance[path] = ordered list of {theme, raw_spec} root->leaf
        provenance = defaultdict(list)
        for t in chain:
            flat = _flatten(t.tokens or {})
            layers.append({"theme_slug": t.slug, "name": t.name,
                           "version": t.version, "tokens": flat})
            for path, spec in flat.items():
                merged[path] = spec
                provenance[path].append({"theme_slug": t.slug, "spec": spec,
                                         "version": t.version})
        return chain, layers, merged, dict(provenance)

    # ---------- resolution ----------
    def _resolve_all(self, merged):
        """Resolve every raw token. Returns resolved values and a cycle report
        for every strongly connected reference ring reachable."""
        raw_type = {}
        for path, spec in merged.items():
            _, typ = _spec_value(spec)
            if typ:
                raw_type[path] = typ

        graph = {}
        for path, spec in merged.items():
            val, _ = _spec_value(spec)
            graph[path] = [r for r in _extract_refs(val) if r in merged]

        cycles = self._find_cycles(graph)
        in_cycle = {p for cyc in cycles for p in cyc}

        resolved, resolve_stack = {}, set()

        def walk(path, trail):
            if path in resolved:
                return
            if path in resolve_stack:
                return  # member of a known cycle; left unresolved on purpose
            if path not in merged:
                raise ResolutionError(f"reference to unknown token {{{path}}}",
                                      path=path)
            resolve_stack.add(path)
            val, _typ = _spec_value(merged[path])
            for ref in graph[path]:
                if ref in resolve_stack:
                    continue
                if ref in in_cycle:
                    continue
                walk(ref, trail + [ref])
            try:
                resolved[path] = _substitute(val, resolved) \
                    if isinstance(val, str) else val
            except ResolutionError:
                resolved[path] = None
            finally:
                resolve_stack.discard(path)

        for path in merged:
            if path not in in_cycle:
                walk(path, [path])
        return resolved, graph, cycles, raw_type

    @staticmethod
    def _find_cycles(graph):
        """Return list of simple cycles (node lists) via DFS."""
        cycles, seen_cycles = [], set()
        WHITE, GRAY, BLACK = 0, 1, 2
        color = defaultdict(int)
        stack = []

        def norm(cyc):
            # rotate so smallest element first; canonical key
            i = cyc.index(min(cyc))
            rot = cyc[i:] + cyc[:i]
            return tuple(rot)

        def dfs(u):
            color[u] = GRAY
            stack.append(u)
            for v in graph.get(u, []):
                if color[v] == GRAY:
                    idx = stack.index(v)
                    cyc = stack[idx:]
                    key = norm(cyc)
                    if key not in seen_cycles:
                        seen_cycles.add(key)
                        cycles.append(list(key) + [key[0]])
                elif color[v] == WHITE:
                    dfs(v)
            stack.pop()
            color[u] = BLACK

        for node in list(graph):
            if color[node] == WHITE:
                dfs(node)
        return cycles

    def static_expand(self, theme, force=False):
        """Fully expand a theme (static expansion). Cached on version sig."""
        sig = self.version_signature(theme)
        cached = self._expand_cache.get(theme.slug)
        if not force and cached and cached["sig"] == sig and \
                time.time() - cached["ts"] < RESOLVE_CACHE_TTL_SECONDS:
            return cached["data"]

        chain, layers, merged, provenance = self.merged_layers(theme)
        resolved, graph, cycles, raw_type = self._resolve_all(merged)

        tokens_out = {}
        for path, spec in merged.items():
            _, typ = _spec_value(spec)
            prov = provenance.get(path, [])
            winner = prov[-1] if prov else None
            shadowed = prov[:-1]
            ref_chain = self._ref_explanation(path, merged, resolved, graph)
            tokens_out[path] = {
                "path": path,
                "raw_value": _spec_value(spec)[0],
                "value": resolved.get(path),
                "resolved": path in resolved and path not in
                           {p for c in cycles for p in c},
                "type": typ,
                "winner": winner,
                "overridden_in": [s["theme_slug"] for s in shadowed],
                "override_priority": [s["theme_slug"] for s in prov],
                "references": graph.get(path, []),
                "resolution_trace": ref_chain,
                "in_cycle": any(path in c for c in cycles),
            }
        data = {
            "theme_slug": theme.slug,
            "theme_name": theme.name,
            "signature": sig,
            "inheritance": [t.slug for t in chain],
            "tokens": tokens_out,
            "cycles": cycles,
            "generated_at": time.time(),
            "cached": False,
        }
        with self._lock:
            self._expand_cache[theme.slug] = {"sig": sig, "ts": time.time(),
                                              "data": data}
            # same signature means any per-token cache is still valid; a changed
            # signature invalidates that theme's resolve cache below.
            if cached and cached["sig"] != sig:
                self._resolve_cache = {
                    k: v for k, v in self._resolve_cache.items()
                    if k[0] != theme.slug or v["sig"] == sig}
        return data

    def _ref_explanation(self, path, merged, resolved, graph):
        """Human/UI explanation of how a value was derived through aliases."""
        trace, seen, cur = [], set(), path
        while cur:
            if cur in seen:
                trace.append({"path": cur, "status": "cycle"})
                break
            seen.add(cur)
            val, _ = _spec_value(merged[cur])
            refs = graph.get(cur, [])
            trace.append({
                "path": cur,
                "raw_value": val,
                "resolved_value": resolved.get(cur),
                "references": refs,
                "status": "alias" if refs else "literal",
            })
            cur = refs[0] if refs else None
        return trace

    def resolve_token(self, slug, path, force=False):
        """Request-time resolution of one token through the inheritance graph."""
        theme = self.theme_by_slug(slug)
        if not theme:
            raise ResolutionError(f"unknown theme {slug!r}")
        sig = self.version_signature(theme)
        key = (slug, path)
        cached = self._resolve_cache.get(key)
        if not force and cached and cached["sig"] == sig and \
                time.time() - cached["ts"] < RESOLVE_CACHE_TTL_SECONDS:
            cached["data"]["cached"] = True
            return cached["data"]

        expansion = self.static_expand(theme)
        if path not in expansion["tokens"]:
            return {"theme_slug": slug, "path": path, "found": False,
                    "signature": sig}
        node = expansion["tokens"][path]
        data = {"theme_slug": slug, "path": path, "found": True,
                "signature": sig, "cached": False, **node}
        with self._lock:
            self._resolve_cache[key] = {"sig": sig, "ts": time.time(),
                                        "data": data}
        return data

    # ---------- versions / cache ----------
    def version_signature(self, theme):
        """Hash the theme *and every ancestor's* token payload + version. Any
        upstream change changes this signature and invalidates caches."""
        chain = self.inheritance_chain(theme)
        h = hashlib.sha256()
        for t in chain:
            h.update(t.slug.encode())
            h.update(str(t.version).encode())
            h.update(json.dumps(t.tokens, sort_keys=True,
                                default=str).encode())
        return h.hexdigest()[:16]

    def invalidate(self, slug=None):
        """Explicit cache invalidation after a token write."""
        with self._lock:
            if slug is None:
                self._expand_cache.clear()
                self._resolve_cache.clear()
            else:
                self._expand_cache.pop(slug, None)
                # descendants also inherit the change -> invalidate them too
                desc = self.descendants(slug)
                for d in desc:
                    self._expand_cache.pop(d, None)
                self._resolve_cache = {
                    k: v for k, v in self._resolve_cache.items()
                    if k[0] not in desc | {slug}}
        return True

    def descendants(self, slug):
        themes = self.db.query(Theme).all()
        children = defaultdict(list)
        by_id = {t.id: t for t in themes}
        for t in themes:
            if t.parent_id:
                children[by_id[t.parent_id].slug].append(t.slug)
        out, stack = set(), list(children.get(slug, []))
        while stack:
            cur = stack.pop()
            if cur in out:
                continue
            out.add(cur)
            stack.extend(children.get(cur, []))
        return out

    def cache_state(self):
        with self._lock:
            return {
                "expansion_entries": {
                    k: {"signature": v["sig"], "age_seconds": round(time.time() - v["ts"], 1)}
                    for k, v in self._expand_cache.items()},
                "resolution_entries": len(self._resolve_cache),
            }

    # ---------- change impact ----------
    def build_reference_graph(self):
        """Global token reference graph across all themes (merged views)."""
        edges, nodes = [], set()
        themes = self.db.query(Theme).all()
        for t in themes:
            _, _, merged, _ = self.merged_layers(t)
            for path, spec in merged.items():
                nodes.add((t.slug, path))
                val, _ = _spec_value(spec)
                for ref in _extract_refs(val):
                    if ref in merged:
                        edges.append({"theme_slug": t.slug,
                                      "from": path, "to": ref})
        return nodes, edges

    def impact_of_change(self, changed_paths, origin_slug=None):
        """Everything affected by changing upstream tokens:

        * descendant themes that inherit the changed paths
        * alias tokens transitively referencing a changed path (reverse edges)
        * components consuming those tokens (directly or through aliases)
        * existing designer confirmations that must go back to review
        """
        changed_paths = set(changed_paths)
        themes = self.db.query(Theme).all()
        affected_themes, affected_paths = set(), {p: set() for p in changed_paths}

        # reverse reference map per theme
        reverse = defaultdict(set)  # (slug, target) -> set(referrers)
        theme_paths = {}
        for t in themes:
            _, _, merged, _ = self.merged_layers(t)
            theme_paths[t.slug] = set(merged)
            for path, spec in merged.items():
                val, _ = _spec_value(spec)
                for ref in _extract_refs(val):
                    if ref in merged:
                        reverse[(t.slug, ref)].add(path)

        seeds = set()
        origin_desc = self.descendants(origin_slug) if origin_slug else set()
        for t in themes:
            for cp in changed_paths:
                if cp in theme_paths[t.slug]:
                    # directly declares or inherits the changed token
                    affected_themes.add(t.slug)
                    seeds.add((t.slug, cp))
        if origin_slug:
            affected_themes |= origin_desc
            for d in origin_desc:
                for cp in changed_paths:
                    seeds.add((d, cp))

        # transitive reverse closure over aliases
        affected_token_set = set()
        stack = list(seeds)
        seen_edge = set()
        while stack:
            slug, path = stack.pop()
            affected_token_set.add((slug, path))
            for referrer in reverse.get((slug, path), []):
                if (slug, referrer) not in seen_edge:
                    seen_edge.add((slug, referrer))
                    stack.append((slug, referrer))

        # component consumption
        components = self.db.query(Component).all()
        comp_impact = []
        affected_flat = defaultdict(set)
        for slug, path in affected_token_set:
            affected_flat[slug].add(path)
        token_universe = {p for _, p in affected_token_set}
        for c in components:
            used = set(c.supported_tokens or [])
            hit = used & token_universe
            if hit:
                comp_impact.append({
                    "component": c.slug, "name": c.name,
                    "via_tokens": sorted(hit),
                })

        return {
            "changed_paths": sorted(changed_paths),
            "origin_theme": origin_slug,
            "affected_themes": sorted(affected_themes),
            "affected_tokens": {s: sorted(p) for s, p in affected_flat.items()},
            "affected_components": comp_impact,
            "invalidated_cache_scopes": sorted(affected_themes |
                                               ({origin_slug} if origin_slug else set())),
        }

    # ---------- coverage ----------
    def theme_coverage(self):
        """For each leaf theme show which component-required tokens are missing
        (theme override gaps)."""
        from .models import Component as C
        components = self.db.query(C).all()
        required = sorted({p for c in components
                           for p in (c.required_token_paths or [])})
        rows = []
        for t in self.db.query(Theme).order_by(Theme.id).all():
            own = set(_flatten(t.tokens or {}).keys())
            _, _, merged, _ = self.merged_layers(t)
            missing = [p for p in required if p not in own]
            inherited_only = [p for p in required
                              if p not in own and p in merged]
            rows.append({"theme_slug": t.slug, "name": t.name,
                         "required": required, "missing_overrides": missing,
                         "inherited_only": inherited_only,
                         "complete": not missing})
        return rows
