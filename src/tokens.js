// 设计令牌：类型校验、别名引用解析（含跨 scope 继承）、别名环检测、
// 覆盖优先级解释、反向依赖闭包（变更影响）。

import { isValidColor } from './color.js';

export const TOKEN_TYPES = ['color', 'fontSize', 'fontWeight', 'spacing', 'radius', 'icon'];

export const REF_RE = /\{([a-z0-9][\w.-]*)\}/gi;

export function expandRefs(value) {
  if (typeof value !== 'string') return { refs: [], has: false };
  const refs = [];
  let m;
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(value)) !== null) refs.push(m[1]);
  return { refs, has: refs.length > 0 };
}

export function validateTokenValue(type, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, error: '值必须是非空字符串' };
  }
  if (expandRefs(value).has) {
    const stripped = value.replace(REF_RE, '');
    if (type === 'color' && stripped && !/^[\s,()rgba0-9.%#]+$/i.test(stripped)) {
      return { ok: false, error: 'color 复合值中存在非法片段' };
    }
    return { ok: true };
  }
  switch (type) {
    case 'color':
      return isValidColor(value) ? { ok: true } : { ok: false, error: '非法颜色值: ' + value };
    case 'fontSize':
    case 'spacing':
    case 'radius':
      return /^\d+(\.\d+)?px$/.test(value)
        ? { ok: true }
        : { ok: false, error: type + ' 必须是像素值，例如 14px' };
    case 'fontWeight':
      return /^(normal|bold|[1-9]00)$/.test(value)
        ? { ok: true }
        : { ok: false, error: 'fontWeight 必须是 100-900 或 normal/bold' };
    case 'icon':
      return /^[a-z][a-z0-9-]*$/.test(value)
        ? { ok: true }
        : { ok: false, error: 'icon 必须是 kebab-case 图标名' };
    default:
      return { ok: false, error: '未知令牌类型: ' + type };
  }
}

export function qid(scope, name) {
  return scope + '::' + name;
}

// reader: { pathOf(scopeId) -> [scopeId,...优先级从高到低], getDef(scopeId, name) }
export class TokenResolver {
  constructor(reader) {
    this.r = reader;
  }

  candidates(name, scopePath) {
    const out = [];
    for (const scope of scopePath) {
      const def = this.r.getDef(scope, name);
      if (def) out.push({ scope, def });
    }
    return out;
  }

  /**
   * 解析令牌为具体值。
   * 返回 ok 结果或 {ok:false, error: CYCLE|UNRESOLVED|INVALID|UNDEFINED,...}
   */
  resolve(name, scopeId, stack = [], overlayPath = undefined) {
    const scopePath = this.r.pathOf(scopeId);
    // 默认叠加层即请求自身继承路径：主题请求时上游别名也能跟随主题覆盖；
    // base/brand 请求时叠加层与词法路径重合，行为不变。
    const overlay = overlayPath === undefined ? scopePath : overlayPath;
    const trace = [];
    const chain = [];
    const value = this.#resolveName(name, scopePath, overlay, stack, trace, chain);
    if (value && value.__error) {
      const { __error, ...rest } = value;
      return { ok: false, error: __error, ...rest, trace };
    }
    const type = trace.length ? trace[trace.length - 1].type : null;
    const validation = type ? validateTokenValue(type, value) : { ok: false };
    if (!validation.ok) {
      return { ok: false, error: 'INVALID', detail: validation.error, value, trace };
    }
    return { ok: true, value, type, trace, chain };
  }

  #resolveName(name, lexicalPath, overlayPath, stack, trace, chain) {
    // 叠加层在前（主题覆盖），词法路径在后（保持去重）
    const lookup = overlayPath
      ? [...new Set([...overlayPath, ...lexicalPath])]
      : lexicalPath;
    const cands = this.candidates(name, lookup);
    if (cands.length === 0) {
      return { __error: 'UNDEFINED', detail: '令牌未定义: ' + name };
    }
    const [{ scope, def }, ...shadows] = cands;
    const id = qid(scope, name);
    if (stack.includes(id)) {
      return {
        __error: 'CYCLE',
        detail: '别名环: ' + [...stack.slice(stack.indexOf(id)), id]
          .map((x) => x.replace('::', '/'))
          .join(' -> ')
      };
    }
    chain.push(id);
    const { refs, has } = expandRefs(def.value);
    let value = def.value;
    if (has) {
      const nextStack = [...stack, id];
      for (const refName of refs) {
        const subTrace = [];
        const subChain = [];
        // 嵌套引用：词法路径是“当前定义所在 scope”，叠加层继续沿主题向下传递
        const subLexical = this.r.pathOf(scope);
        const sub = this.#resolveName(refName, subLexical, overlayPath, nextStack, subTrace, subChain);
        if (sub && sub.__error) return sub;
        value = value.replaceAll('{' + refName + '}', sub);
        trace.push(...subTrace);
        chain.push(...subChain);
      }
    }
    trace.push({
      name, scope, value: def.value, resolved: value, type: def.type,
      shadows: shadows.map((s) => ({ scope: s.scope, value: s.def.value }))
    });
    return value;
  }
}

// 在所有 scope 上扫描别名环与坏引用，返回问题清单
export function auditReferences(reader, scopeIds) {
  const resolver = new TokenResolver(reader);
  const issues = [];
  const seenCycles = new Set();
  for (const scopeId of scopeIds) {
    for (const name of reader.namesAt(scopeId)) {
      const res = resolver.resolve(name, scopeId);
      if (!res.ok) {
        if (res.error === 'CYCLE') {
          if (!seenCycles.has(res.detail)) {
            seenCycles.add(res.detail);
            issues.push({ code: 'ALIAS_CYCLE', scope: scopeId, name, detail: res.detail });
          }
        } else if (res.error === 'UNDEFINED') {
          issues.push({ code: 'BROKEN_ALIAS', scope: scopeId, name, detail: res.detail });
        } else if (res.error === 'INVALID') {
          issues.push({ code: 'INVALID_RESOLVED_VALUE', scope: scopeId, name, detail: res.detail });
        }
      }
    }
  }
  return issues;
}

// 别名依赖边：source 定义处 -> 实际解析到的 target 定义处（跨 scope）
export function buildAliasEdges(reader, scopeIds) {
  const resolver = new TokenResolver(reader);
  const edges = [];
  for (const scopeId of scopeIds) {
    for (const name of reader.namesAt(scopeId)) {
      const def = reader.getDef(scopeId, name);
      const { refs } = expandRefs(def.value);
      for (const refName of refs) {
        const cands = resolver.candidates(refName, reader.pathOf(scopeId));
        if (cands.length) edges.push({ from: qid(scopeId, name), to: qid(cands[0].scope, refName) });
      }
    }
  }
  return edges;
}

// 反向别名闭包：给定变更起点 def，返回所有（传递）引用它的 def
export function reverseAliasClosure(starts, edges) {
  const reverse = new Map();
  for (const e of edges) {
    if (!reverse.has(e.to)) reverse.set(e.to, new Set());
    reverse.get(e.to).add(e.from);
  }
  const out = new Set(starts);
  const queue = [...starts];
  while (queue.length) {
    const cur = queue.pop();
    for (const up of reverse.get(cur) ?? []) {
      if (!out.has(up)) { out.add(up); queue.push(up); }
    }
  }
  return out;
}
