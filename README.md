# 开发设计规范手册（Design Guide Handbook）

一个可交互的设计规范系统：在 Web 文档里**比较颜色、字号、图标与表单状态**；
令牌服务负责**解析品牌 / 主题继承**；PostgreSQL 持久化**设计版本与组件依赖**；
后台生成**检查报告**。核心难点（令牌别名环、覆盖优先级、真实状态对比度、
缓存失效与变更影响、确认复查、截图中断恢复、导出可追溯）全部落地并由
31 个自动化测试守护。

## 一键启动

```bash
pip install -r requirements.txt          # 或使用本机已装依赖
./run_dev.sh                             # 内嵌 PG → 建表/种子 → http://127.0.0.1:8080
```

- 文档界面（交互）：<http://127.0.0.1:8080/>
- OpenAPI：<http://127.0.0.1:8080/docs>
- 数据库：嵌入式 PostgreSQL 18（`scripts/dev_pg.sh`，unix socket `/tmp:55432`）

测试：

```bash
./scripts/dev_pg.sh start PGPORT=55432    # 首次需确保 PG 在跑（脚本自动建 designguide_test）
PGPORT=55432 \
DATABASE_URL='postgresql+psycopg2://postgres@/designguide_test?host=/tmp&port=55432' \
python3 -m pytest -q
```

## 文档界面能做什么

| 页签 | 能力 |
| --- | --- |
| **令牌浏览器** | 主题继承图（base→light/dark→experimental）；每套主题的**静态展开**；点击令牌查看请求时解析、引用链与**覆盖优先级**（根→叶子，生效层打勾，被覆盖层划线）；环上令牌红色标注；更新上游令牌后实时显示缓存失效范围、变更影响列表、被置为“待复查”的确认 |
| **颜色对比** | 任意前景×背景组合的实时 WCAG 比例（支持透明色合成）；“组件真实状态对比矩阵”逐组件/状态/主题给出真实解析色与判定，**禁用态标注“豁免，不计入合格演示”** |
| **字号字重** | 以解析值实时渲染字号阶梯，标注令牌路径与生效主题 |
| **图标 / 组件状态** | 按钮 / 输入框（default/helper/error/disabled）/ 图标按钮 / 卡片的**运行示例**，颜色全部来自解析后的令牌；硬编码图标色、低对比、禁用态均直接标注；组件依赖图 |
| **截图与确认** | 截图任务状态（completed/interrupted/pending）、中断步骤与令牌版；一键恢复；设计师确认**绑定具体截图 + 该截图渲染时的令牌哈希**；导出带 `@source` 注释与 `<metadata>` 来源块的标注 SVG |
| **检查报告** | 后台线程生成，前端轮询；按规则/严重度汇总，每条 finding 可展开“证据” |

> 界面上所有色块、比例与说明文案都来自接口实时计算结果（`/api/.../rendered`、
> `/api/compare`、`/api/export/...`），**文本说明与运行示例天然一致**。

## 设计与实现要点

### 令牌模型、别名与循环检测
- 主题 JSON 中的叶子节点为字面值或 `{ "value": "{other.token}", "type": ... }` 别名。
- 引用语法 `{dotted.path}`；解析器建引用图，DFS 找出全部简单环，环上令牌标记
  `resolved=false`，不会被静默赋一个错值；详情面板高亮环路。
- 未知引用解析为 `null` 并在展开结果可见；**写入若会制造环，接口 409 拒绝**（事务回滚）。

### 主题继承与覆盖优先级
- `inheritance_chain` 自叶子向上到根，再反转为根→叶子；同一路径最后声明的层生效。
- 每个解析结果带 `winner`（生效层）、`overridden_in`（被覆盖层）、
  `override_priority`（完整层序），UI 用划线/打勾解释“谁覆盖了谁”。
- 子主题缺失的令牌沿父链继承；但**组件契约要求的令牌必须在叶子主题显式覆盖**，
  即使继承得到也算“主题覆盖漏项”（深色主题故意漏 `color.border.strong`）。

### “合法颜色 ≠ 可读”：对比绑定真实使用状态
- `/api/compare` 与报告都在**具体组件×具体状态×具体主题**上取真实前景/背景计算
  WCAG 比例（普通文本 4.5:1、大字/UI 3:1，含 alpha 合成）。
- 种子数据中 `color.text.subtle=#9ca3af` 是合法 hex，但输入框 helper 态
  2.54:1 被判不合格——合法值从不直接当合格。
- **禁用态豁免对比度，且绝不计为“合格演示”**：报告记录 info（`counted_as_pass=false`）；
  若某组件只有禁用示例可“展示”，另出 error。

### 静态展开 vs 请求时解析；缓存失效与变更影响
- `static_expand(slug)`：物化整套主题（全部令牌 + 引用链 + 环 + 优先级）。
- `resolve_token(slug, path)`：请求时沿继承图解析单个令牌。
- 两层缓存为**进程内共享**（跨请求），以“主题+所有祖先的版本/内容哈希”为签名做
  门槛，配合 TTL；任何上游令牌写入：版本号 +1 → 显式 invalidate 本主题及全部后代
  → 返回影响列表（受影响主题、别名反向闭包命中的令牌、消费这些令牌的组件）。
- 写入同时把受影响的设计师确认置为 `needs_rereview`。

### 设计师确认基于截图 + 令牌版
- 确认必须选择一张**已完成**的截图；确认记录保存截图渲染时的哈希与当前哈希。
- 用**旧截图**确认不会清除待复查：接口返回 `confirmed=false` 与中文原因，
  需用当前令牌重新截图后再确认（`tests/test_flows.py` 覆盖完整闭环）。

### 后台报告规则
`alias_cycle`、`theme_override_gap`、`contrast_state`、`disabled_demo`、
`dynamic_icon_color`（硬编码/不可解析/低于 3:1）、`legacy_component_token`
（旧组件未支持新引入的 `color.focus.ring`）、`screenshot_interrupted`
（中断与 pending，可恢复）、`traceability`、`stale_confirmation`。
报告在后台线程生成，`POST /api/reports` 立即返回 id，`GET /api/reports/{id}` 轮询。

### 截图任务与导出追溯
- 任务分步 `acquire → resolve_tokens → render → persist`；可在任一步注入中断，
  恢复时从失败步骤继续，保留已解析的令牌哈希。
- 成品 SVG 内嵌 `<metadata id="design-provenance">`（组件/主题/状态/令牌哈希/
  设计版本/逐令牌解析值）；导出接口额外输出逐角色 `@source` 注释与标注 JSON。

## PostgreSQL 表（`backend/models.py`）
`brands, themes(parent 自引用), design_versions(JSONB 快照),
components, component_dependencies, component_version_support,
screenshot_tasks, confirmations, check_reports(JSONB), audit_events`。

## 种子数据覆盖的验收场景
别名环（experimental）、深色主题覆盖漏项、helper 文本对比不足、动态图标硬编码且
低对比、legacy-card 未支持新令牌、一个中断 + 一个 pending 截图任务、一条基于旧
令牌版的确认。

## API 速览
`GET /api/themes/{slug}/expand` · `GET /api/themes/{slug}/tokens/{path}` ·
`GET /api/cycles` · `GET /api/coverage` · `PUT /api/tokens` ·
`POST /api/compare` · `GET /api/components/{slug}/rendered` ·
`POST /api/screenshots`（`fail_before_step` / `resume`）·
`POST /api/confirmations` · `POST /api/reports` · `GET /api/reports/{id}` ·
`GET /api/export/{component}/{theme}/{state}` · `POST /api/versions/freeze`。
