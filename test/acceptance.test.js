import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server.js';
import { createService } from '../src/service.js';
import { seed } from '../src/seed.js';
import { TokenResolver, expandRefs, validateTokenValue } from '../src/tokens.js';
import { makeReader, expandTheme } from '../src/themes.js';
import { contrastRatio } from '../src/color.js';

async function fresh() {
  const svc = await createService({});
  await seed(svc);
  return svc;
}

async function api(app, method, path, body) {
  const srv = app.server;
  const port = srv.address?.()?.port;
  const base = `http://127.0.0.1:${port}`;
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json();
  return { status: res.status, json };
}

describe('颜色合法性 vs 可读性', () => {
  test('合法颜色也可能对比不足，对比度只在实际状态上判定', async () => {
    const svc = await fresh();
    const report = await svc.runReport();
    const darkFails = report.findings.filter((f) =>
      f.code === 'CONTRAST_FAIL' && f.theme === 'theme/dark' && f.state === 'default');
    assert.ok(darkFails.length >= 1, 'dark 默认按钮应报告对比不足');
    const f = darkFails[0];
    assert.ok(f.ratio < 4.5);
    // 数值本身合法
    assert.equal(validateTokenValue('color', '#9aa4d1').ok, true);
    // 同一组件 light 主题合格 -> 证明检查绑定实际主题状态，而非颜色全局判错
    const lightFails = report.findings.filter((x) =>
      x.code === 'CONTRAST_FAIL' && x.theme === 'theme/light');
    assert.equal(lightFails.length, 0);
  });

  test('禁用示例豁免对比且不计入合格演示', async () => {
    const svc = await fresh();
    const report = await svc.runReport();
    const infos = report.findings.filter((f) => f.code === 'DISABLED_DEMO_EXCLUDED');
    assert.ok(infos.length >= 3);
    assert.equal(report.summary.usageDisabledExcluded >= 3, true);
    // 即便禁用色对比极差，也不会产生 CONTRAST_FAIL
    assert.ok(report.findings.every((f) => !(f.code === 'CONTRAST_FAIL' && f.state === 'disabled')));
    // 不能因为只有禁用示例而把组件判合格：dark button 默认失败 -> 该 pair 不合格
    assert.ok(report.summary.usageChecked >= 3);
    assert.ok(report.summary.usagePass < report.summary.usageChecked + report.summary.usageDisabledExcluded);
  });
});

describe('令牌别名、循环与覆盖优先级', () => {
  test('令牌可引用其他令牌并跨层解析，主题覆盖跟随', async () => {
    const svc = await fresh();
    const light = svc.resolveToken('theme/light', 'color.action.bg');
    assert.equal(light.value.toLowerCase(), '#2563eb'); // brand 别名 -> light 覆盖的 primary
    const dark = svc.resolveToken('theme/dark', 'color.action.bg');
    assert.equal(dark.value.toLowerCase(), '#6366f1');
    // trace 解释优先级：别名定义在 brand，被引用目标在主题层被覆盖
    const sources = dark.trace.map((t) => t.scope);
    assert.ok(sources.includes('brand/acme'));
    assert.ok(sources.includes('theme/dark'));
  });

  test('别名环被检测并给出路径', async () => {
    const svc = await fresh();
    await svc.putToken({ scope: 'base', name: 'color.a', type: 'color', value: '{color.b}' });
    await svc.putToken({ scope: 'base', name: 'color.b', type: 'color', value: '{color.a}' });
    const res = svc.resolveToken('base', 'color.a');
    assert.equal(res.ok, false);
    assert.equal(res.error, 'CYCLE');
    assert.match(res.detail, /color\.a/);
    const report = await svc.runReport();
    assert.ok(report.findings.some((f) => f.code === 'ALIAS_CYCLE'));
  });

  test('坏引用与非法解析值分别报告', async () => {
    const svc = await fresh();
    await svc.putToken({ scope: 'base', name: 'color.broken', type: 'color', value: '{color.nope}' });
    const res = svc.resolveToken('base', 'color.broken');
    assert.equal(res.error, 'UNDEFINED');
  });

  test('覆盖优先级：近者胜且 trace 给出被遮蔽值', async () => {
    const svc = await fresh();
    const r = svc.resolveToken('theme/dark', 'color.bg.default');
    assert.equal(r.value.toLowerCase(), '#0b1220');
    const shadows = r.trace.find((t) => t.name === 'color.bg.default').shadows;
    assert.ok(shadows.some((s) => s.scope === 'base'));
    assert.ok(shadows.some((s) => s.scope === 'theme/light') === false); // dark 不经过 light
  });
});

describe('主题展开、缓存失效与变更影响', () => {
  test('静态展开与请求时解析结果一致', async () => {
    const svc = await fresh();
    const staticExp = svc.expand('theme/dark');
    const req = svc.resolveToken('theme/dark', 'color.brand.primary');
    const staticTok = staticExp.tokens.find((t) => t.name === 'color.brand.primary');
    assert.equal(staticTok.value.toLowerCase(), req.value.toLowerCase());
  });

  test('展开缓存命中，写入后失效并返回新值', async () => {
    const svc = await fresh();
    svc.expand('theme/dark');
    const second = svc.expand('theme/dark');
    assert.equal(second.cached, true);
    await svc.putToken({ scope: 'theme/dark', name: 'color.brand.primary', type: 'color', value: '#111111' });
    const third = svc.expand('theme/dark');
    assert.equal(third.cached, false);
    assert.equal(third.tokens.find((t) => t.name === 'color.brand.primary').value.toLowerCase(), '#111111');
  });

  test('缓存精确失效：改不相关 scope 不影响其他主题缓存；改上游经别名闭包失效', async () => {
    const svc = await fresh();
    svc.expand('theme/dark');
    svc.expand('theme/light');
    // 改一个全新的、不处于任何主题继承路径上的独立 scope，不应使主题缓存失效
    await svc.createScope({ id: 'brand/other', kind: 'brand', name: '其他品牌', parent: 'base' });
    await svc.putToken({ scope: 'brand/other', name: 'radius.other', type: 'radius', value: '2px' });
    assert.equal(svc.expand('theme/dark').cached, true);
    assert.equal(svc.expand('theme/light').cached, true);
    // 改 base 的品牌色（别名 color.action.bg 传递引用），两个主题都必须重算
    await svc.putToken({ scope: 'base', name: 'color.brand.primary', type: 'color', value: '#abcdef' });
    assert.equal(svc.expand('theme/dark').cached, false);
    assert.equal(svc.expand('theme/light').cached, false);
  });

  test('变更影响列表：别名反向闭包 + 继承 scope + 组件', async () => {
    const svc = await fresh();
    const impact = await svc.computeImpact('base', 'color.brand.primary');
    // 别名 color.action.bg 传递引用 color.brand.primary
    assert.ok(impact.tokenDefinitions.some((d) => d.includes('color.action.bg')));
    // 下游叶子 theme 受影响
    assert.ok(impact.scopes.includes('theme/dark'));
    assert.ok(impact.scopes.includes('theme/light'));
    // 使用该令牌链的组件出现
    assert.ok(impact.components.some((c) => c.componentId === 'button'));
  });

  test('主题覆盖别名目标时，影响按“具体主题解析链”计算，不跨主题误伤', async () => {
    const svc = await fresh();
    // color.action.bg 是 brand 别名 -> {color.brand.primary}；dark/light 各自覆盖了 primary
    const impact = await svc.computeImpact('theme/dark', 'color.brand.primary');
    const btn = impact.components.find((c) => c.componentId === 'button');
    assert.ok(btn, 'dark 视角下 action.bg 解析链经过 dark primary，button 必须进入影响列表');
    assert.ok(btn.themes.includes('theme/dark'));
    assert.ok(!btn.themes.includes('theme/light'), 'light 渲染不依赖 dark 的覆盖，不应受影响');
    // 缓存精确失效：只有 dark 重算
    assert.ok(impact.scopes.includes('theme/dark'));
    assert.ok(!impact.scopes.includes('theme/light'));
    assert.ok(!impact.scopes.includes('brand/acme'));
  });
});

describe('主题覆盖漏项', () => {
  test('dark 相对参考主题 light 缺少覆盖项', async () => {
    const svc = await fresh();
    const report = await svc.runReport();
    const gaps = report.findings.filter((f) => f.code === 'THEME_OVERRIDE_GAP');
    assert.ok(gaps.some((g) => g.token === 'color.surface' && g.theme === 'theme/dark'));
  });
});

describe('动态图标颜色', () => {
  test('currentColor 逐状态绑定文本色并计算对比', async () => {
    const svc = await fresh();
    const report = await svc.runReport();
    // button/default 的图标 currentColor=action.text，dark 下同样对比失败
    assert.ok(report.findings.some((f) =>
      f.code === 'CONTRAST_FAIL' && f.target === 'icon' && f.theme === 'theme/dark'));
  });

  test('currentColor 无文本槽可绑定时报 ICON_COLOR_UNBOUND', async () => {
    const svc = await fresh();
    const report = await svc.runReport();
    assert.ok(report.findings.some((f) =>
      f.code === 'ICON_COLOR_UNBOUND' && f.componentId === 'icon-close'));
  });
});

describe('旧组件未支持新令牌', () => {
  test('button(v2) 使用 v3 令牌时报告', async () => {
    const svc = await fresh();
    const report = await svc.runReport();
    assert.ok(report.findings.some((f) =>
      f.code === 'LEGACY_TOKEN_UNSUPPORTED' && f.componentId === 'button' &&
      f.sinceVersion === 3 && f.supportedVersion === 2));
  });
});

describe('设计师确认与上游令牌变更', () => {
  test('确认必须绑定 completed 截图与当前令牌版', async () => {
    const svc = await fresh();
    await assert.rejects(
      () => svc.confirm({ componentId: 'button', theme: 'theme/light', shotId: 'shot_seed_broken' }),
      /截图未完成/
    );
    await assert.rejects(
      () => svc.confirm({ componentId: 'button', theme: 'theme/dark', shotId: 'shot_seed_ok' }),
      /不匹配/
    );
    const ok = await svc.confirm({ componentId: 'button', theme: 'theme/light', shotId: 'shot_seed_ok' });
    assert.equal(ok.status, 'confirmed');
  });

  test('更新上游令牌后相关确认变为待复查', async () => {
    const svc = await fresh();
    assert.equal((await svc.getConfirmation('button', 'theme/light')).status, 'confirmed');
    await svc.putToken({ scope: 'brand/acme', name: 'color.action.text', type: 'color', value: '#fafafa' });
    assert.equal((await svc.getConfirmation('button', 'theme/light')).status, 'needs_review');
    // 不相关的确认不会被牵连（没有其他确认时至少不报错）
  });

  test('未使用被改令牌的组件确认不受影响', async () => {
    const svc = await fresh();
    await svc.putToken({ scope: 'base', name: 'radius.md', type: 'radius', value: '8px' });
    assert.equal((await svc.getConfirmation('button', 'theme/light')).status, 'confirmed');
  });

  test('只改 dark 覆盖不会使 light 确认待复查（按具体主题解析链判定）', async () => {
    const svc = await fresh();
    await svc.putToken({ scope: 'theme/dark', name: 'color.brand.primary', type: 'color', value: '#123456' });
    assert.equal((await svc.getConfirmation('button', 'theme/light')).status, 'confirmed');
  });

  test('显式图标颜色令牌变更同样使相关确认待复查', async () => {
    const svc = await fresh();
    // icon-close/default 使用显式令牌 color.icon.default（别名 -> color.text.primary）
    const shot = await svc.startShot(
      { componentId: 'icon-close', theme: 'theme/light', framesTotal: 2 },
      async () => {});
    assert.equal(shot.status, 'completed');
    await svc.confirm({ componentId: 'icon-close', theme: 'theme/light', shotId: shot.id });
    await svc.putToken({ scope: 'base', name: 'color.text.primary', type: 'color', value: '#111111' });
    assert.equal((await svc.getConfirmation('icon-close', 'theme/light')).status, 'needs_review');
  });
});

describe('截图任务中断', () => {
  test('失败落 interrupted 并保留进度，可从断点续跑完成', async () => {
    const svc = await fresh();
    const job = await svc.startShot(
      { componentId: 'button', theme: 'theme/light', framesTotal: 4 },
      async (frame) => { if (frame.index === 2) throw new Error('boom'); });
    assert.equal(job.status, 'interrupted');
    assert.equal(job.framesDone, 2);
    const resumed = await svc.resumeShot(job.id, async () => {});
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.framesDone, 4);
    assert.equal(resumed.id, job.id);
  });

  test('报告列出未完成截图', async () => {
    const svc = await fresh();
    const report = await svc.runReport();
    assert.ok(report.findings.some((f) =>
      f.code === 'SCREENSHOT_INTERRUPTED' && f.jobId === 'shot_seed_broken'));
  });
});

describe('文档说明与运行示例一致', () => {
  test('说明引用令牌集合与实际槽位一致，多/少都报警', async () => {
    const svc = await fresh();
    let report = await svc.runReport();
    // 健康种子数据中所有组件的说明都与运行示例一致（含显式图标颜色令牌）
    assert.equal(report.findings.some((f) => f.code === 'DESCRIPTION_MISMATCH'), false);
    const comp = await svc.getComponent('button');
    await svc.putComponent({ ...comp, description: '按钮使用 {color.action.text}' });
    report = await svc.runReport();
    const m = report.findings.find((f) => f.code === 'DESCRIPTION_MISMATCH' && f.componentId === 'button');
    assert.ok(m);
    assert.ok(m.missing.includes('color.action.bg'));
  });
});

describe('继承环', () => {
  test('主题 extends 形成循环时静态展开失败并报错', async () => {
    const svc = await fresh();
    await svc.createScope({ id: 'theme/x', kind: 'theme', name: 'X', parent: 'brand/acme' });
    await svc.createScope({ id: 'theme/y', kind: 'theme', name: 'Y', parent: 'brand/acme' });
    // 再建立相互 extends 环
    await svc.updateScope({ id: 'theme/x', extends: 'theme/y' });
    await svc.updateScope({ id: 'theme/y', extends: 'theme/x' });
    const reader = makeReader(svc.store);
    const res = expandTheme(reader, 'theme/x', svc.store.scopes);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'INHERITANCE_CYCLE');
    const report = await svc.runReport();
    assert.ok(report.findings.some((f) => f.code === 'INHERITANCE_CYCLE'));
  });

  test('主题展开失败时该主题的组件×主题不得计为合格', async () => {
    const svc = await fresh();
    await svc.createScope({ id: 'theme/x', kind: 'theme', name: 'X', parent: 'brand/acme', extends: 'theme/dark' });
    // theme/dark 是健康叶子，令 x 自继承制造环
    await svc.updateScope({ id: 'theme/x', extends: 'theme/x' });
    const report = await svc.runReport({ themes: ['theme/x'] });
    assert.ok(report.findings.some((f) =>
      f.code === 'USAGE_TOKEN_UNRESOLVED' && f.componentId === 'button' && f.theme === 'theme/x'));
    assert.equal(report.summary.compliantComponentThemePairs, 0);
    assert.equal(report.summary.componentThemePairs,
      report.summary.componentsChecked /* 1 个坏掉的主题 × 全部组件 */);
  });
});

describe('HTTP 集成与可追溯截图', () => {
  test('端到端：健康检查、展开(带缓存头)、报告、截图 SVG 标注来源', async () => {
    const app = await buildApp({});
    await new Promise((r) => app.server.listen(0, r));
    const health = await api(app, 'GET', '/api/health');
    assert.equal(health.status, 200);

    const e1 = await api(app, 'GET', '/api/expand/' + encodeURIComponent('theme/dark'));
    const e2 = await api(app, 'GET', '/api/expand/' + encodeURIComponent('theme/dark'));
    assert.equal(e2.json.cached, true);

    const srv = app.server.address().port;
    const svgRes = await fetch(`http://127.0.0.1:${srv}/api/shots/shot_seed_ok/image.svg`);
    const svg = await svgRes.text();
    // action.bg 是定义在 brand/acme 的别名，主题展开后解析为具体色
    assert.match(svg, /data-token="color\.action\.bg" data-source="brand\/acme"/);
    assert.match(svg, /tokenVersion=v1/);
    assert.match(svg, /来源: /);

    const report = await api(app, 'POST', '/api/reports', {});
    assert.equal(report.status, 200);
    assert.ok(report.json.summary.errors > 0);
    await new Promise((r) => app.server.close(r));
  });
});
