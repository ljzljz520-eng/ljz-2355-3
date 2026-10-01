// 设计检查报告生成器。
// 核心原则：
//  1) 颜色合法 ≠ 可读 —— 只在“组件 × 主题 × 实际使用状态”上做对比检查；
//  2) disabled 状态豁免对比且不计入合格演示（避免禁用示例凑数）；
//  3) 图标颜色是动态的（currentColor 绑定该状态文本色），逐状态计算；
//  4) 检查使用的是解析后的具体值与来源链，报告可追溯到令牌定义。

import { auditReferences } from './tokens.js';
import { expandTheme, inheritancePath, overrideGaps } from './themes.js';
import { contrastRatio, isLargeText, meetsAA } from './color.js';

const SEVERITY = {
  ALIAS_CYCLE: 'error',
  BROKEN_ALIAS: 'error',
  INVALID_RESOLVED_VALUE: 'error',
  INHERITANCE_CYCLE: 'error',
  USAGE_TOKEN_UNRESOLVED: 'error',
  ICON_COLOR_UNBOUND: 'error',
  SCREENSHOT_INTERRUPTED: 'error',
  CONTRAST_FAIL: 'error',
  THEME_OVERRIDE_GAP: 'warning',
  LEGACY_TOKEN_UNSUPPORTED: 'warning',
  DESCRIPTION_MISMATCH: 'warning',
  DISABLED_DEMO_EXCLUDED: 'info'
};

export function finding(code, message, extra = {}) {
  return { code, severity: SEVERITY[code] ?? 'warning', message, ...extra };
}

function resolvedValueMap(themeExpansion) {
  const m = new Map();
  for (const t of themeExpansion.tokens) m.set(t.name, t);
  return m;
}

export async function generateReport(store, reader, { themes, now = new Date().toISOString() } = {}) {
  const findings = [];
  const scopeList = await store.listScopes();
  const scopeMap = new Map(scopeList.map((s) => [s.id, s]));
  const scopeIds = scopeList.map((s) => s.id);

  // ---- 全局：继承环 ----
  for (const s of scopeList) {
    const { cycle } = inheritancePath(s.id, scopeMap);
    if (cycle) {
      findings.push(finding('INHERITANCE_CYCLE',
        `scope 继承存在循环，起点 ${cycle.at}：${cycle.chain.join(' -> ')}`,
        { scope: s.id, chain: cycle.chain }));
    }
  }

  // ---- 全局：别名环 / 坏引用 / 非法解析值 ----
  for (const issue of auditReferences(reader, scopeIds)) {
    findings.push(finding(issue.code, issue.detail, { scope: issue.scope, name: issue.name }));
  }

  // ---- 主题：覆盖漏项 + 缓存展开 ----
  const checkThemes = themes ?? scopeList.filter((s) => s.kind === 'theme').map((s) => s.id);
  const expansions = new Map();
  for (const themeId of checkThemes) {
    const scope = scopeMap.get(themeId);
    if (!scope) continue;
    const exp = expandTheme(reader, themeId, scopeMap);
    expansions.set(themeId, exp);
    const refId = scope.reference ?? null;
    if (refId && scopeMap.has(refId)) {
      for (const gap of overrideGaps(themeId, refId, reader, scopeMap)) {
        findings.push(finding('THEME_OVERRIDE_GAP',
          `主题 ${scope.name} 缺少相对参考主题 ${scopeMap.get(refId).name} 的覆盖: ${gap.name}`,
          { theme: themeId, reference: refId, token: gap.name, referenceValue: gap.referenceValue }));
      }
    }
    for (const e of exp.errors ?? []) {
      findings.push(finding('USAGE_TOKEN_UNRESOLVED',
        `主题 ${scope.name} 中令牌 ${e.name} 解析失败: ${e.detail}`,
        { theme: themeId, token: e.name, error: e.error }));
    }
  }

  const components = await store.listComponents();
  const currentVersion = await store.latestVersionNumber();
  let usageChecked = 0, usagePass = 0, usageDisabled = 0;

  for (const component of components) {
    for (const themeId of checkThemes) {
      const exp = expansions.get(themeId);
      if (!exp || !exp.ok) {
        // 主题整体不可解析（继承环等）：该组件×主题不能算合格
        findings.push(finding('USAGE_TOKEN_UNRESOLVED',
          `${component.name} 在 ${scopeMap.get(themeId)?.name ?? themeId} 上无法评估：主题展开失败`,
          { componentId: component.id, component: component.name, theme: themeId }));
        continue;
      }
      const values = resolvedValueMap(exp);

      for (const usage of component.usages ?? []) {
        const isDisabled = usage.state === 'disabled';
        const ctx = { componentId: component.id, component: component.name, theme: themeId, usage: usage.id, state: usage.state };

        // 先保证用到的令牌都能解析
        const slotResults = {};
        let unresolved = false;
        for (const [slot, spec] of Object.entries(usage.slots ?? {})) {
          const hit = values.get(spec.token);
          if (!hit || hit.value == null) {
            findings.push(finding('USAGE_TOKEN_UNRESOLVED',
              `${component.name}/${usage.label ?? usage.id} 在 ${scopeMap.get(themeId).name} 的 ${slot} 使用了无法解析的令牌 ${spec.token}`,
              { ...ctx, slot, token: spec.token }));
            unresolved = true;
          } else {
            slotResults[slot] = hit;
          }
        }
        if (unresolved) continue;

        // 旧组件未支持新令牌
        for (const spec of Object.values(usage.slots ?? {})) {
          const hit = values.get(spec.token);
          const since = hit?.source ? reader.getDef(hit.source, hit.name)?.meta?.sinceVersion : null;
          if (since && Number(since) > Number(component.supportedTokenVersion ?? 1)) {
            findings.push(finding('LEGACY_TOKEN_UNSUPPORTED',
              `${component.name}（支持令牌 v${component.supportedTokenVersion}）使用了 v${since} 才引入的 ${spec.token}`,
              { ...ctx, token: spec.token, sinceVersion: since, supportedVersion: component.supportedTokenVersion }));
          }
        }

        if (isDisabled) {
          // 豁免对比，且绝不计入合格演示
          usageDisabled += 1;
          findings.push(finding('DISABLED_DEMO_EXCLUDED',
            `${component.name}/${usage.label ?? usage.id}（disabled）已豁免对比，不计入合格演示`,
            { ...ctx }));
        } else {
          usageChecked += 1;
          const stateFailures = checkContrast(usage, slotResults);
          if (stateFailures.length === 0) usagePass += 1;
          for (const f of stateFailures) findings.push(finding('CONTRAST_FAIL', f.message, { ...ctx, ...f }));
        }

        // 动态图标颜色：逐状态计算；currentColor 绑定文本槽，无文本槽则未绑定
        if (usage.icon) {
          const bg = slotResults[usage.icon.backgroundSlot ?? 'background'];
          let colorHit = null;
          if (usage.icon.color === 'currentColor') {
            colorHit = slotResults[usage.icon.textSlot ?? 'text'];
            if (!colorHit) {
              findings.push(finding('ICON_COLOR_UNBOUND',
                `${component.name}/${usage.label ?? usage.id} 的图标使用 currentColor 但该状态没有文本槽可绑定`,
                { ...ctx, icon: usage.icon.name }));
            }
          } else {
            colorHit = values.get(usage.icon.color);
            if (!colorHit || colorHit.value == null) {
              findings.push(finding('ICON_COLOR_UNBOUND',
                `${component.name}/${usage.label ?? usage.id} 的图标颜色令牌 ${usage.icon.color} 在该主题无法解析`,
                { ...ctx, icon: usage.icon.name, token: usage.icon.color }));
              colorHit = null;
            }
          }
          if (colorHit && bg && !isDisabled) {
            const ratio = contrastRatio(colorHit.value, bg.value);
            if (!meetsAA(ratio, { ui: true })) {
              findings.push(finding('CONTRAST_FAIL',
                `${component.name}/${usage.label ?? usage.id} 图标对比 ${ratio.toFixed(2)} 低于 3.0（${scopeMap.get(themeId).name}）`,
                { ...ctx, target: 'icon', ratio, required: 3,
                  fg: colorHit.value, bg: bg.value, token: colorHit.name,
                  source: colorHit.source, trace: colorHit.trace }));
            }
          }
        }
      }
    }

    // ---- 文本说明与运行示例一致：说明里引用的令牌集合必须等于运行示例实际使用集合 ----
    // “实际使用”含显式图标颜色令牌（currentColor 不是令牌名，其绑定的文本槽令牌已在 slots 中），
    // 与 service.computeImpact 统计组件引用的口径保持一致，避免图标令牌被误判为“说明多出”。
    const described = new Set([...(component.description ?? '').matchAll(/\{([a-z0-9][\w.-]*)\}/gi)].map((m) => m[1]));
    const used = new Set();
    for (const u of component.usages ?? []) {
      for (const s of Object.values(u.slots ?? {})) used.add(s.token);
      if (u.icon && u.icon.color && u.icon.color !== 'currentColor') used.add(u.icon.color);
    }
    const missing = [...used].filter((t) => !described.has(t));
    const extra = [...described].filter((t) => !used.has(t));
    if (missing.length || extra.length) {
      findings.push(finding('DESCRIPTION_MISMATCH',
        `${component.name} 文档说明与示例令牌不一致（说明缺 ${missing.length} 个、多出 ${extra.length} 个）`,
        { componentId: component.id, missing, extra }));
    }
  }

  // ---- 截图任务：中断 / 未完成却被确认引用 ----
  for (const job of await store.listShots()) {
    if (job.status === 'interrupted' || job.status === 'running' || job.status === 'pending') {
      findings.push(finding('SCREENSHOT_INTERRUPTED',
        `截图任务 ${job.id} 状态为 ${job.status}（${job.framesDone}/${job.framesTotal} 帧），确认不可依赖该截图`,
        { jobId: job.id, componentId: job.componentId, theme: job.theme, status: job.status,
          framesDone: job.framesDone, framesTotal: job.framesTotal, resumeFrom: job.framesDone }));
    }
  }

  // ---- 汇总：合格组件只统计“非禁用状态全部通过、且无任何组件级 error”的组件×主题 ----
  // 对比失败、未解析令牌、图标颜色未绑定等都使其不合格；
  // 禁用示例不参与（既不能让它合格，也不会因为豁免而冤枉组件）。
  const COMPONENT_LEVEL_ERRORS = new Set([
    'CONTRAST_FAIL', 'USAGE_TOKEN_UNRESOLVED', 'ICON_COLOR_UNBOUND'
  ]);
  const compliance = new Map();
  for (const f of findings) {
    if (f.severity !== 'error' || !f.componentId || !f.theme) continue;
    if (!COMPONENT_LEVEL_ERRORS.has(f.code)) continue;
    compliance.set(f.componentId + '::' + f.theme, false);
  }
  const pairs = new Set();
  for (const c of components) for (const t of checkThemes) pairs.add(c.id + '::' + t);
  let compliantPairs = 0;
  for (const k of pairs) if (compliance.get(k) !== false) compliantPairs += 1;

  const summary = {
    generatedAt: now,
    themesChecked: checkThemes.length,
    componentsChecked: components.length,
    usageChecked,              // 不含 disabled
    usagePass,
    usagePassRate: usageChecked ? Number((usagePass / usageChecked).toFixed(3)) : null,
    usageDisabledExcluded: usageDisabled,
    componentThemePairs: pairs.size,
    compliantComponentThemePairs: compliantPairs,
    tokenVersion: currentVersion,
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    infos: findings.filter((f) => f.severity === 'info').length
  };

  return { id: null, summary, findings };
}

// 文本/背景对比：large text 依据字号令牌的数值与字重
function checkContrast(usage, slotResults) {
  const failures = [];
  const text = slotResults.text;
  const bg = slotResults.background;
  if (text && bg) {
    const ratio = contrastRatio(text.value, bg.value);
    const fontSizeHit = slotResults.fontSize ?? null;
    const large = fontSizeHit ? isLargeText({
      type: 'fontSize',
      value: parseFloat(fontSizeHit.value),
      meta: { fontWeight: usage.fontWeight ?? Number(fontSizeHit?.meta?.fontWeight ?? 400) }
    }) : false;
    const required = large ? 3 : 4.5;
    if (!meetsAA(ratio, { large })) {
      failures.push({
        message: `文本对比 ${ratio.toFixed(2)} 低于 ${required}（state=${usage.state}）`,
        target: 'text', ratio, required, large,
        fg: text.value, bg: bg.value, token: text.name, source: text.source, trace: text.trace
      });
    }
  }
  return failures;
}
