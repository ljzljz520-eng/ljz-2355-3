// Scope/品牌/主题继承模型：
//   base（基础层，无父）
//     └─ brand（品牌层，parent=base，可有多个品牌）
//          └─ theme（主题层，extends 另一个 theme 形成链，循环会被检测）
// 解析路径优先级：theme 自身 -> extends 链（近→远）-> brand -> base

import { TokenResolver } from './tokens.js';

export function inheritancePath(scopeId, scopeMap) {
  const path = [];
  const seen = new Set();
  let cur = scopeId;
  let cycle = null;
  while (cur) {
    if (seen.has(cur)) {
      cycle = { at: cur, chain: [...path, cur] };
      break;
    }
    seen.add(cur);
    path.push(cur);
    const sc = scopeMap.get(cur);
    if (!sc) break;
    if (sc.kind === 'theme') cur = sc.extends ?? sc.parent ?? null;
    else cur = sc.parent ?? null;
  }
  return { path, cycle };
}

export function makeReader(store) {
  return {
    pathOf: (scopeId) => inheritancePath(scopeId, store.scopes).path,
    getDef: (scope, name) => store.getTokenDef(scope, name),
    namesAt: (scope) => store.namesAt(scope)
  };
}

/**
 * 静态展开某主题/品牌：把继承路径上可见的每个令牌解析为具体值。
 * 仅在令牌/scope 变更时重算（由 ThemeCache 控制），请求时解析走同一解析器。
 */
export function expandTheme(reader, scopeId, scopeMap) {
  const { path, cycle } = inheritancePath(scopeId, scopeMap);
  if (cycle) return { ok: false, error: 'INHERITANCE_CYCLE', detail: cycle };
  const resolver = new TokenResolver(reader);
  const visible = new Map(); // name -> winning scope
  for (const sc of path) {
    for (const name of reader.namesAt(sc)) {
      if (!visible.has(name)) visible.set(name, sc);
    }
  }
  const tokens = [];
  const errors = [];
  for (const [name, source] of visible) {
    const res = resolver.resolve(name, scopeId);
    const overrides = path
      .filter((sc) => sc !== source && reader.getDef(sc, name))
      .map((sc) => ({ scope: sc, value: reader.getDef(sc, name).value }));
    if (res.ok) {
      tokens.push({
        name, value: res.value, type: res.type, source,
        overrides, trace: res.trace
      });
    } else {
      errors.push({ name, error: res.error, detail: res.detail });
      tokens.push({ name, value: null, type: reader.getDef(source, name)?.type, source, overrides, error: res });
    }
  }
  tokens.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: errors.length === 0, scope: scopeId, path, tokens, errors };
}

// 变更影响：某个 scope 上的定义发生变化 -> 继承路径经过该 scope 的全部叶子 scope
export function affectedScopes(changedScope, scopeIds, scopeMap) {
  const out = [];
  for (const id of scopeIds) {
    const { path } = inheritancePath(id, scopeMap);
    if (path.includes(changedScope)) out.push(id);
  }
  return out;
}

// 主题链：从主题自身沿 extends 向上，直到进入品牌/基础层（不含）
export function themeChain(themeId, scopeMap) {
  const chain = [];
  let cur = themeId;
  const guard = new Set();
  while (cur && scopeMap.get(cur)?.kind === 'theme' && !guard.has(cur)) {
    guard.add(cur);
    chain.push(cur);
    cur = scopeMap.get(cur).extends ?? null;
  }
  return chain;
}

// 主题覆盖漏项：参考主题自身直接定义、但本主题链上任何层级都没有覆盖的令牌
export function overrideGaps(themeId, referenceId, reader, scopeMap) {
  const chain = new Set(themeChain(themeId, scopeMap));
  return reader.namesAt(referenceId)
    .filter((name) => ![...chain].some((sc) => reader.getDef(sc, name)))
    .map((name) => ({ name, referenceValue: reader.getDef(referenceId, name).value }));
}

// 精确失效缓存：
//  - 每次写入只 bump 受影响 scope 的 epoch（由 service.computeImpact 给出）
//  - 每个主题缓存键 = 该主题“继承路径”上各 scope epoch 的组合
//  - 因此改不相关 scope（如改 base 的圆角）不会让主题色板缓存失效；
//    改继承路径上的任意 scope（含别名引用到的上游）必然改变键而重算
export class ThemeCache {
  constructor() {
    this.entries = new Map(); // scopeId -> {key, data}
    this.epoch = new Map();   // scopeId -> n
    this.global = 0;          // scope 拓扑变化（新增/改 extends）时整体加一
  }

  invalidateAll() {
    this.global += 1;
  }

  invalidate(scopeIds) {
    for (const id of scopeIds) this.epoch.set(id, (this.epoch.get(id) ?? 0) + 1);
  }

  get(scopeId, compute, deps) {
    const pathDeps = deps ?? [scopeId];
    const key = this.global + '|' + pathDeps
      .map((s) => s + '=' + (this.epoch.get(s) ?? 0))
      .sort()
      .join(',');
    const hit = this.entries.get(scopeId);
    if (hit && hit.key === key) return { data: hit.data, cached: true };
    const data = compute();
    this.entries.set(scopeId, { key, data });
    return { data, cached: false };
  }
}
