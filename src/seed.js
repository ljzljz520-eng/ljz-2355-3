// 演示种子数据。刻意覆盖全部验收情形：
//  - 别名环可由 API 临时构造；种子本身保持健康
//  - dark 主题 action 文字色“合法但不可读”（对比不足）
//  - dark 相对 light 存在覆盖漏项 color.surface
//  - button 支持 v2 却使用 sinceVersion=3 的 color.action.bg（旧组件新令牌）
//  - 图标 currentColor 动态绑定文本色；另有一处未绑定
//  - 一张已完成截图+确认；一张中断截图

export async function seed(svc) {
  const s = svc.store;

  for (const scope of [
    { id: 'base', kind: 'base', name: '基础层' },
    { id: 'brand/acme', kind: 'brand', name: 'Acme 品牌', parent: 'base' },
    { id: 'theme/light', kind: 'theme', name: '浅色主题', parent: 'brand/acme', reference: null },
    { id: 'theme/dark', kind: 'theme', name: '深色主题', parent: 'brand/acme', reference: 'theme/light' }
  ]) await s.upsertScope(scope);

  const tok = async (scope, name, type, value, meta = {}) =>
    s.putToken({ scope, name, type, value, meta });

  // base
  await tok('base', 'color.text.primary', 'color', '#1f2937');
  await tok('base', 'color.text.inverse', 'color', '#f9fafb');
  await tok('base', 'color.bg.default', 'color', '#ffffff');
  await tok('base', 'color.bg.muted', 'color', '#f3f4f6');
  await tok('base', 'color.brand.primary', 'color', '#2563eb');
  await tok('base', 'color.state.disabled.text', 'color', '#9ca3af');
  await tok('base', 'color.state.disabled.bg', 'color', '#f3f4f6');
  await tok('base', 'font.size.body', 'fontSize', '14px');
  await tok('base', 'font.size.heading', 'fontSize', '24px', { fontWeight: 400 });
  await tok('base', 'font.weight.bold', 'fontWeight', '700');
  await tok('base', 'radius.md', 'radius', '6px');
  await tok('base', 'icon.chevron', 'icon', 'chevron-down');

  // brand/acme（令牌可引用其他令牌；别名跨层解析，主题覆盖别名目标时跟随主题）
  await tok('brand/acme', 'color.brand.primary', 'color', '#4f46e5');
  await tok('brand/acme', 'color.action.bg', 'color', '{color.brand.primary}', { sinceVersion: 3 });
  await tok('brand/acme', 'color.action.text', 'color', '#ffffff');
  await tok('brand/acme', 'color.icon.default', 'color', '{color.text.primary}');

  // theme/light（作为 dark 的参考主题）
  await tok('theme/light', 'color.bg.default', 'color', '#ffffff');
  await tok('theme/light', 'color.text.primary', 'color', '#1f2937');
  await tok('theme/light', 'color.brand.primary', 'color', '#2563eb');
  await tok('theme/light', 'color.surface', 'color', '#ffffff');

  // theme/dark：故意缺 color.surface（覆盖漏项）
  // color.action.text 合法但与 action 背景对比不足（约 2.7:1）
  await tok('theme/dark', 'color.bg.default', 'color', '#0b1220');
  await tok('theme/dark', 'color.bg.muted', 'color', '#1f2937');
  await tok('theme/dark', 'color.text.primary', 'color', '#e5e7eb');
  await tok('theme/dark', 'color.brand.primary', 'color', '#6366f1');
  await tok('theme/dark', 'color.action.text', 'color', '#9aa4d1');

  // ---- components ----
  await s.putComponent({
    id: 'button',
    name: '按钮 Button',
    supportedTokenVersion: 2, // 旧组件：使用 v3 才有的 color.action.bg
    description: '按钮使用 {color.action.text} 配 {color.action.bg}（悬停 {color.brand.primary}），字号 {font.size.body}；禁用态 {color.state.disabled.text} / {color.state.disabled.bg}',
    usages: [
      {
        id: 'default', label: '默认', state: 'default',
        slots: {
          text: { token: 'color.action.text' },
          background: { token: 'color.action.bg' },
          fontSize: { token: 'font.size.body' }
        },
        icon: { name: 'chevron-down', color: 'currentColor', textSlot: 'text', backgroundSlot: 'background' }
      },
      {
        id: 'hover', label: '悬停', state: 'hover',
        slots: {
          text: { token: 'color.action.text' },
          background: { token: 'color.brand.primary' },
          fontSize: { token: 'font.size.body' }
        }
      },
      {
        id: 'disabled', label: '禁用', state: 'disabled',
        slots: {
          text: { token: 'color.state.disabled.text' },
          background: { token: 'color.state.disabled.bg' },
          fontSize: { token: 'font.size.body' }
        }
      }
    ]
  });

  await s.putComponent({
    id: 'icon-close',
    name: '图标按钮 IconClose',
    supportedTokenVersion: 3,
    description: '关闭图标使用 {color.icon.default}，背景 {color.bg.default}；圆形状态使用 currentColor（动态绑定，背景 {color.bg.muted}）',
    usages: [
      {
        id: 'default', label: '默认', state: 'default',
        slots: { background: { token: 'color.bg.default' } },
        icon: { name: 'x', color: 'color.icon.default', backgroundSlot: 'background' }
      },
      {
        // currentColor 但该状态没有文本槽 -> 动态颜色未绑定（必须报错）
        id: 'circle', label: '圆形', state: 'default',
        slots: { background: { token: 'color.bg.muted' } },
        icon: { name: 'circle', color: 'currentColor', backgroundSlot: 'background' }
      }
    ]
  });

  await s.putComponent({
    id: 'text-input',
    name: '输入框 TextInput',
    supportedTokenVersion: 3,
    description: '输入框文字 {color.text.primary}，背景 {color.bg.default}，字号 {font.size.body}；禁用态 {color.state.disabled.text} / {color.state.disabled.bg}',
    usages: [
      {
        id: 'default', label: '默认', state: 'default',
        slots: {
          text: { token: 'color.text.primary' },
          background: { token: 'color.bg.default' },
          fontSize: { token: 'font.size.body' }
        }
      },
      {
        id: 'disabled', label: '禁用', state: 'disabled',
        slots: {
          text: { token: 'color.state.disabled.text' },
          background: { token: 'color.state.disabled.bg' },
          fontSize: { token: 'font.size.body' }
        }
      }
    ]
  });

  // 设计版本 v1（截图与确认绑定它）
  const v1 = await svc.createVersion({ label: '初始版', createdBy: 'seed' });

  // 完成截图 + 已确认
  const goodShot = {
    id: 'shot_seed_ok', componentId: 'button', theme: 'theme/light',
    tokenVersion: v1.number, status: 'completed', framesTotal: 4, framesDone: 4,
    imageUrl: '/shots/shot_seed_ok/image.svg',
    source: { componentVersion: 2, createdAt: new Date().toISOString() },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  await s.putShot(goodShot);
  await s.putConfirmation({
    componentId: 'button', theme: 'theme/light', status: 'confirmed',
    tokenVersion: v1.number, shotId: goodShot.id, confirmedBy: 'designer-a',
    confirmedAt: new Date().toISOString(), reasons: []
  });

  // 中断截图（2/4）
  await s.putShot({
    id: 'shot_seed_broken', componentId: 'button', theme: 'theme/dark',
    tokenVersion: v1.number, status: 'interrupted', framesTotal: 4, framesDone: 2,
    source: { componentVersion: 2, createdAt: new Date().toISOString() },
    error: '渲染进程退出',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  });

  svc.cache.invalidateAll();
  return { version: v1 };
}
