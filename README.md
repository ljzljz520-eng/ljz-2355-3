# 开发设计规范手册

一个可交互的设计规范工作台：在文档界面里**比较颜色、字号、图标与表单状态**；token 服务解析**品牌与主题继承**；PostgreSQL 保存**设计版本与组件依赖**；后台生成**检查报告**。

零运行时依赖（Node ≥ 20 内置 `node:http` / `node:test`）。设置 `DATABASE_URL` 后切换到 PostgreSQL，不设置时使用等价的内存存储，方便本地演示与 CI。

## 快速开始

```bash
npm start                 # http://localhost:3000（内存存储，自动播种演示数据）
DATABASE_URL=postgres://user:pass@localhost:5432/design_handbook npm start
npm test                  # 26 个验收测试
```

PG 模式首次启动自动执行 `src/storage/schema.sql`，库为空时自动播种。需要安装 `pg`（`npm install pg`）。

## 需求到实现的对照

| 需求 | 实现 |
| --- | --- |
| 令牌可引用其他令牌、检测循环、解释覆盖优先级 | `src/tokens.js`：`{token.name}` 引用、词法路径解析 + 主题叠加层、`CYCLE` 与完整 trace（命中 scope、原始值、被遮蔽候选） |
| 颜色合法 ≠ 可读；对比绑定实际使用状态 | `src/color.js`（WCAG 亮度/对比，支持 alpha 合成）+ `src/checker.js` 在「组件 × 主题 × 状态」槽位上计算，不是全局判颜色 |
| 禁用示例不能误计为合格演示 | disabled 状态**豁免对比且不计入分母**，只产生 `DISABLED_DEMO_EXCLUDED(info)`；组件×主题只有全部非禁用状态通过才算合格 |
| 静态展开每套主题 vs 请求时解析继承图 | `expandTheme()` 静态全量展开；`resolve()` 请求时解析；两者共用同一个解析器，测试断言结果一致 |
| 缓存失效 + 变更影响列表 | `ThemeCache` 按 scope epoch 失效；`computeImpact()` 以**具体 scope/主题请求视角的解析链**求闭包（词法别名反向边 + 主题叠加覆盖，定点扩张），输出按主题标注的受影响组件与确认；只改 dark 覆盖不会让 light 重算或待复查 |
| 主题覆盖漏项 | scope 上声明 `reference` 参考主题，`overrideGaps()` 找参考主题自定义但本主题链未覆盖的令牌 |
| 动态图标颜色 | icon 颜色可为具体令牌或 `currentColor`（绑定该状态文本槽）；无文本槽报 `ICON_COLOR_UNBOUND`；对比按状态计算 |
| 旧组件未支持新令牌 | 定义携带 `meta.sinceVersion`，组件有 `supportedTokenVersion`，越界报 `LEGACY_TOKEN_UNSUPPORTED` |
| 确认基于具体组件截图与令牌版；上游变更 → 待复查 | `confirm()` 强校验 completed 截图、组件/主题匹配、截图令牌版=当前版；写令牌时按「组件 × 主题」解析链精确置 `needs_review`（含显式图标颜色令牌，currentColor 绑定的文本槽随 slots 生效），并记录失效原因；PG 模式同步落库 |
| 截图任务中断 | 帧级状态 `framesDone/framesTotal`，失败/中断可从断点 `resume`；未完成截图进报告并禁止确认 |
| 导出设计图标注可追溯来源 | SVG 每个元素带 `data-token` / `data-source` / 主题 / `tokenVersion` / 帧数 |
| 文本说明与运行示例一致 | 组件 `description` 中 `{token}` 集合必须等于示例槽位实际引用集合，多/少都报 `DESCRIPTION_MISMATCH` |
| PG 保存设计版本及组件依赖 | `design_versions`（令牌快照 + 组件版本依赖）、`components`、`confirmations` 等 7 张表，见 `src/storage/schema.sql` |

## 别名解析语义（重要）

引用写成 `{color.brand.primary}`。解析采用**词法路径 + 主题叠加层**：

1. 一个令牌名先沿「请求主题的继承路径」（主题自身 → extends 链 → 品牌 → 基础）确定叠加层；
2. 别名定义处仍按其**词法继承路径**解析引用，保证跨层引用与环检测正确；
3. 叠加层优先，所以品牌层定义的别名 `{color.brand.primary}` 在 dark 主题里会跟随 dark 对该名字的覆盖。

环（含跨层自引用）在解析结果里返回 `{ok:false,error:'CYCLE',detail:'别名环: a -> b -> a'}`，后台报告会去重后列出。

## HTTP API 摘要

```
GET  /api/health
GET  /api/scopes            POST /api/scopes            /api/scopes 亦可 POST 同 id 更新（updateScope）
POST /api/tokens            GET /api/resolve?scope=&name=      DELETE /api/tokens {scope,name}
GET  /api/expand/:scope?cache=0
POST /api/impact {scope,name}
GET/POST /api/components
GET/POST /api/versions
GET  /api/shots             POST /api/shots {componentId,theme,failAtFrame?}
POST /api/shots/:id/interrupt | /resume
GET  /api/shots/:id/image.svg
GET/POST /api/confirmations
POST /api/reports           GET /api/reports | /api/reports/:id
```

scope 含 `/`（如 `theme/dark`）时在路径段中使用 `encodeURIComponent`。

## 目录

```
src/color.js      WCAG 颜色/对比度（alpha 合成、大号文本阈值）
src/tokens.js     令牌校验、别名解析、环检测、反向依赖闭包
src/themes.js     品牌/主题继承图、静态展开、覆盖漏项、失效缓存
src/checker.js    后台检查报告（状态绑定对比、图标、漏项、旧组件、截图、说明一致性）
src/service.js    应用服务：写入失效、影响列表、版本、截图帧、确认复查
src/storage/      memory.js（默认） + pg.js + schema.sql
src/server.js     HTTP API 与可追溯 SVG 截图
src/seed.js       覆盖全部验收情形的演示数据
web/              交互式单页（比较/组件状态/解析解释/报告/截图确认/版本）
test/             26 个 node:test 验收用例
```
