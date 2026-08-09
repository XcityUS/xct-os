# 交接清单 — 需要人工操作的事项

自动化能做的都做了。下面这些卡在凭据或生产风险上，需要你来。
状态截至 2026-08-07 凌晨；完整设计见 `~/.claude/plans/foamy-conjuring-kazoo.md`，
改动边界见 `XCITY-INTEGRATION.md`。

## 当前进度

| 阶段 | 状态 |
|---|---|
| Phase 1 统一登录 / 2 模型面 / 3 KWH 门禁 | ✅ 已在产线（Worker `fa349951`），**休眠中**，等下面第 1 节 |
| Phase 4 Agent Persona | 🟡 PR [xct-os#2](https://github.com/XcityUS/xct-os/pull/2) 待合并（本文档在这个 PR 里） |
| Phase 5 媒体生成 + MCP 配置 | 🟡 PR [xct-os#3](https://github.com/XcityUS/xct-os/pull/3) 待合并 |
| 人格导入脚本 | 🟡 PR [xct-agents#5](https://github.com/XcityUS/xct-agents/pull/5) 待合并 |
| wallet 周度免费额 | ✅ **已在产线并生效** —— 迁移已执行，free 用户读余额即触发发放 |

合并 xct-os#2 和 #3 之后，跑一次 starter 部署把代码送上产线：

```bash
cd /Users/javen/workspace/cloudflare-os-starter && git pull && git -C cloudflare-os fetch origin && git -C cloudflare-os checkout origin/main && env -u CLOUDFLARE_API_TOKEN pnpm check && env -u CLOUDFLARE_API_TOKEN pnpm deploy
```

`xcity.enabled` 仍是 `false`，所以这次部署行为零变化 —— 只是把新代码放到位。

---

## 1. 点亮 Xcity SSO（阻塞 Phase 1/2/3 真正生效）

代码已在产线（os.xcity.ai，Worker 版本 `fa349951`），但全部休眠 —— 缺 OAuth client。

### 1.1 在 GoTrue 注册 OAuth client

`auth.xcity.ai` 是 GoTrue v2.189 的 OAuth 2.1 授权服务器。动态注册未广告，走 admin API：

```bash
curl -X POST https://auth.xcity.ai/admin/oauth/clients \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "Xcity OS",
    "client_type": "confidential",
    "redirect_uris": [
      "https://os.xcity.ai/gatekeeper/xcity/oauth",
      "http://localhost:8787/gatekeeper/xcity/oauth"
    ],
    "grant_types": ["authorization_code", "refresh_token"]
  }'
```

注意 **`GOTRUE_URI_ALLOW_LIST` 不是这里** —— 那个管的是传统流程的 `redirect_to` 白名单，
与 OAuth 2.1 服务器的 client 记录无关。redirect URI 是 client 记录自身的属性。

第二个 localhost 条目是给本地 `pnpm dev-server` 验证用的，不想要可以去掉。

### 1.2 把凭据装到 gatekeeper Worker

```bash
cd /Users/javen/workspace/cloudflare-os-starter/cloudflare-os/packages/gatekeeper-xcity
env -u CLOUDFLARE_API_TOKEN npx wrangler secret put CLIENT_ID --name xct-os-gatekeeper-xcity
env -u CLOUDFLARE_API_TOKEN npx wrangler secret put CLIENT_SECRET --name xct-os-gatekeeper-xcity
```

（Worker 要先存在 —— 它在 `xcity.enabled` 首次部署时才创建，所以这一步在 1.3 之后跑，
或者先跑一次部署让 Worker 出现。）

### 1.3 翻开关并部署

在 `cloudflare-os-starter/deployment.jsonc` 把 `xcity.enabled` 改成 `true`，然后：

```bash
cd /Users/javen/workspace/cloudflare-os-starter && env -u CLOUDFLARE_API_TOKEN pnpm check && env -u CLOUDFLARE_API_TOKEN pnpm deploy
```

**⚠️ 这一步会同时关闭 Cloudflare Access**（两种登录模式互斥 —— Access 在边缘拦整个域名，
开着就走不到应用自己的登录页）。所以顺序很重要：

1. 先在**本地**验证登录：`pnpm dev-server`，导出 `XCITY_CLIENT_ID` / `XCITY_CLIENT_SECRET`，
   访问 http://localhost:8787 点 "Continue with Xcity"
2. **本地验证时第一件要确认的事**：token 响应里有没有 `refresh_token`。
   GoTrue 的 `scopes_supported` 里没有 `offline_access`（我们请求不了它），
   而 `acceptAuthCode()` 拿不到 refresh token 会直接抛错。
   这是整套方案唯一未经真机验证的假设。若真的没有 refresh_token，
   Phase 3 的余额门禁就拿不到长期 token，需要改用别的持有方式 —— 叫我处理。
3. 本地通过后再翻生产开关

回滚：把 `xcity.enabled` 改回 `false` 重新部署，即回到 Access 模式，零数据迁移
（两种模式的账号都用 `idFromName(email)` 寻址，同一邮箱落同一个 UserDurableObject）。

---

## 2. tokenhub 的 `PROXY_BASE_URL`（阻塞 Phase 5 的 MCP 半边）

tokenhub 的 MCP OAuth 元数据把自己广告成明文 HTTP：

```json
{"issuer":"http://tokenhub.xcity.ai","authorization_endpoint":"http://tokenhub.xcity.ai/v1/mcp/oauth/authorize"}
```

根因是 litellm 在反代后没算对公开地址。litellm 自己的错误提示里写了修法
（`litellm/proxy/_experimental/mcp_server/oauth_utils.py:452-457`）：
在 tokenhub 的 Railway 服务上设

```
PROXY_BASE_URL=https://tokenhub.xcity.ai
```

验证：

```bash
curl -s https://tokenhub.xcity.ai/.well-known/oauth-authorization-server | jq .issuer
```

应返回 `https://tokenhub.xcity.ai`。

**我没有替你设**：改这个变量会触发 tokenhub 重新部署，而它是全栈唯一的推理入口
（xct-chat / xct-agent-desktop / xct-studio / xct-home / xct-os 全走它）；
这个变量在 litellm 里还影响 UI 与 SSO 回调，不只 MCP。夜里无人值守时不该动。

修好之后 xct-os 侧**零代码改动** —— `gatekeeper-mcp-portal` 本就内建 per-user 的 `oauth` 模式，
配置接线已经做好（默认关闭），翻开即可。这同时补上了 `ARCHITECTURE-REVIEW.md` 记录的
**G-MCP3**（两端都持有 per-user bearer 却都不转发，导致 `litellm_mcpusercredentials`
的 BYOK 注入永远触发不了）。

---

## 3. 导入 agent 人格到 tokenhub skills（阻塞 Phase 4 的 Persona 真正生效）

脚本：`xct-agents/integrations/litellm/import_skills.py`（新增，README 已更新）。
需要 `LITELLM_MASTER_KEY`。**265 个** agent（不是之前说的 313 —— 那个数字把 README、
examples、无 frontmatter 的 strategy 文档都算进去了）。

### ⚠️ 顺序约束：必须先改 xct-home，再跑导入

不是"导入后多出一堆条目"那么轻。`xct-home/src/lib/litellm.ts:693-737` 的 `listSkills`
**没有分页也没有 limit**，拿的是服务端默认的 50 条、按 uuid 随机序排。导入 265 条之后，
页面上显示的 50 条会变成随机切片 —— **现有的真实 skills 极可能直接从
`/skills`、`/zh/skills`、`/dashboard`、`/dashboard/resources` 消失**。
而且每个套餐的 `litellm_skills` 都是 `['*']`（`src/lib/billing.ts:122,137,152`），
265 条人格会显示成所有套餐都可用。

**所以：先在 xct-home 落地过滤与分页，再跑导入。** 反过来做，`/skills` 会在修复上线前一直是坏的。

xct-home 侧要改的（无需改 schema —— 列表端点本来就返回 `xct_metadata`）：
1. `listSkills` 把 `xct_metadata` 透传进 `SkillInfo`，并用 `?limit=200` + `next_cursor` 分页取全
2. `getSkillCatalog`（`src/lib/catalog.ts:166-173`）按 `source_repo !== 'xct-agents'` 过滤；
   人格要么不展示，要么单独一个 "Agent personas" 区块链去 agents 目录
3. 判别字段用 `xct_metadata.source_repo` / `kind: "agent-persona"`，精确且稳定

### 导入本身

先 dry-run（只发 GET，已验证）：

```bash
cd /Users/javen/workspace/xct-agents/integrations/litellm
LITELLM_MASTER_KEY=... python import_skills.py --dry-run
```

幂等靠内容 sha256 指纹（存在 `xct_metadata.content_sha256`，排除了 `imported_at` 之类
易变字段，所以无关提交不会造成 churn）；重跑只碰真正变了的条目。已对着本地桩验证：
首轮 265 创建，二轮 265 unchanged、零写入。

### 一个需要决策的设计缺口

**`skill_id` 无法由客户端指定** —— `XCTSkillCreate`（`xct-litellm/litellm/types/xct_skills.py:13-26`）
没有该字段，列是 `@default(uuid())`。所以「`skill_id` = slug」做不到，
slug 存在 `xct_metadata.xct_agent_slug` 里，脚本的 `--export-map` 可导出 slug→uuid 映射。

这影响 xct-os：它需要按 slug 找人格，而注入端点只认 `skill_id`。两条路：
- **推荐**：给 xct-litellm 加 3 行（`XCTSkillCreate` 加可选 `skill_id` 并传进 `create_data`），
  slug 直接当 id，POST 同时变成真正的 upsert 目标
- 或 xct-os 侧拉全表建 slug→id 索引（列表端点无字段投影，一次几 MB，要重缓存）

我会在 Phase 4 里先按第二条实现（不依赖上游改动），但第一条更干净。

### 另外两点

- **10 个人格正文含 Jinja 标记**（`{{ }}` / `{% %}`，如 `cms-developer`、`security-architect`）。
  `injection.py::_render_prompt` 用 StrictUndefined，会抛→退回 `format_map`→可能再抛→
  最终返回原文。通常结果正确但不保证。脚本每次运行都会列出这些。
- 265 条 × 平均 13.5 KB ≈ 3.6 MB。列表端点没有字段投影，会整表返回 —— xct-home 分页后
  每次缓存 miss 会拉几 MB，要么缓存重一点，要么找上游加个 `fields=` 摘要模式。

---

## 4. 其他已知待办（不阻塞）

- **xct-home**：`/v1/kwh/ledger` 会把 `free_weekly` 原样显示给用户，需要文案映射；
  周额度现在是 16/20 两种取值（按当月周数摊分），UI 不要硬编码 "20 KWH/week"
- **xct-wallet**：`GET /v1/wallet/balance` 的 `plan` 读 JWT claim 而发放读数据库，
  JWT 过期时同一响应会自相矛盾（既存问题，被周度额度这个特性显形）
- **xct-wallet**：`grantCredits` 不参与外层事务，`referrals.ts` 里的 `withTransaction` 是空转
- **xct-litellm**：`marketplace_config.py:29` 的默认 gateway URL 已 404
  （活着的是 `xct-agent-gateway-production`）；
  `endpoints.py:449/452/294/296` 的几个过滤器因 agent card 白名单永远命中不了
