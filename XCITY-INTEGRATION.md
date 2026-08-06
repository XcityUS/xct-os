# Xcity 整合说明（fork 专属）

本仓库是 [`cloudflare/cloudflare-os`](https://github.com/cloudflare/cloudflare-os) 的 fork，
用于把 Cloudflare OS 接入 Xcity 技术栈（xct-auth / xct-wallet / xct-litellm / xct-home /
xct-studio）。部署在 https://os.xcity.ai。

上游演进很快，这份文档定义**改动边界**，目的是让 `git rebase upstream/main` 一直保持可控。

## 目录约定

所有 Xcity 逻辑只允许出现在这些**新增**位置：

| 位置 | 内容 |
|---|---|
| `packages/workshop-backend/src/xcity/` | 模型面、余额门禁、agent 目录等后端逻辑 |
| `packages/gatekeeper-xcity/` | 统一登录 + Xcity 能力面（wallet / skills / 媒体生成）的 Gatekeeper |
| `XCITY-INTEGRATION.md` | 本文档 |

新增文件不会与上游冲突，rebase 时零成本。

## 允许修改的上游文件：四个接缝点

**除下列位置外，不修改任何上游文件。** 每处改动限一个分支判断，且必须由环境变量门控 ——
不设 `XCITY_*` 变量时，行为必须与上游完全一致。这条同时保证了随时可回滚。

| # | 接缝 | 文件 | 改法 |
|---|---|---|---|
| 1 | 认证 | `packages/workshop-backend/src/auth/` + 部署配置 | 不改代码。通过 `AUTH_GATEKEEPERS=xcity` 白名单启用 `gatekeeper-xcity`（上游既有机制，见 `docs/oauth-signin.md`） |
| 2 | 模型面 | `packages/workshop-backend/src/ai-models.ts` — `getModel()` | 在 `options.userGateway` 分支**之前**插入一个 `XCITY_TOKENHUB_URL` 门控分支，复用 `getModelDirect()` 的构造方式携带 per-user key。不碰 Cloudflare AI Gateway 的任何代码路径 |
| 2b | quick model | `packages/workshop-backend/src/ai-gateway.ts` — `getQuickModelConfig()` | 门控下改用 tokenhub 的便宜模型替代硬编码的 Workers AI |
| 3 | 额度门禁 | overseer 中 `checkUsageAndBalance` 的调用点 | 按 `XCITY_WALLET_URL` 门控，二选一地调用 `xcity/usage-checker.ts`；返回值与 `ai-gateway-billing/limits/usage-checker.ts` 的 `UsageCheckResult` 同形状 |
| 4 | Gadget 能力 | `packages/gatekeeper-mcp-portal/` | 转发用户的 tokenhub bearer；其余能力走新增的 `gatekeeper-xcity` |
| 5 | 本地开发 | `run-dev-server.js` — `SHARED_GATEKEEPER_CREDS` | 加一行 `"gatekeeper-xcity": { id: "XCITY_CLIENT_ID", secret: "XCITY_CLIENT_SECRET" }`。仅影响本地 dev，不影响生产 |
| 6 | 登录后置 | `packages/workshop-backend/src/auth/login-flow.ts` | Xcity 登录成功后把 GoTrue `sub` 存进 UserDurableObject（`setXcityIdentity`）。接缝 1 说"不改代码"，但铸 per-user litellm key 必须要这个 id，且这里是它唯一的自然落点。改动限于一个 `vendorId === XCITY_VENDOR_ID` 分支，与既有的 Cloudflare 分支并列 |
| 7 | 附件能力 | `chat-attachment-validation.ts` / `chat-attachment-pdf.ts` / `overseer.ts` 的调用点 | 把完整 `AiModelConfig` 而非仅 `provider` 传下去，让 tokenhub 的 per-model `vision` / `pdf_input` 能力生效。无 Xcity 元数据时逐字回落原有的 `ATTACHMENT_SUPPORT_BY_PROVIDER` 表 |

**已知的结构性取舍**：Xcity 的模型元数据以 `XcityAiModelConfig = AiModelConfig & { xcity?: … }`
的形式挂在共享类型上（`xcity/model-plane.ts`）。好处是元数据随配置天然流到每个消费点，
无需到处传第二个参数；代价是给一个跨 RPC 边界的共享类型做了结构化扩展。
上游若给 `AiModelConfig` 加了运行时校验，这里会最先出问题。

Gatekeeper 本身按目录名 `gatekeeper-*` 自动发现并绑定为 `GATEKEEPER_XCITY`（见 `run-dev-server.js` 的 `findGatekeepers` 与 `packages/workshop-backend/src/auth/auth-vendors.ts`），无需改注册表。

前端文案（KWH 余额、充值引导）不可避免会碰到 `CloudflareUsageInfo` 的消费组件 ——
改动同样以门控为准，且尽量收敛在渲染层。

## 环境变量

| 变量 | 作用 | 不设时 |
|---|---|---|
| `XCITY_TOKENHUB_URL` | tokenhub 基址，如 `https://tokenhub.xcity.ai` | 模型面回落上游行为（BYOK / AI Gateway） |
| `XCITY_WALLET_URL` | wallet 基址，如 `https://wallet.xcity.ai`；模型面用它铸 per-user litellm key，额度门禁也会用它 | 模型面回落上游行为；额度门禁回落上游 `ENABLE_CLOUDFLARE_LIMITS` 逻辑 |
| `XCITY_AUTH_URL` | GoTrue 基址，如 `https://auth.xcity.ai` | gatekeeper-xcity 不可用 |
| `XCITY_HOME_URL` | xct-home 基址，如 `https://xcity.ai`（agent 目录、充值跳转） | agent 目录与充值引导不可用 |
| `WALLET_SERVICE_TOKEN` | 铸 per-user litellm key 用（**secret**） | 无法自动发 key |
| `XCITY_QUICK_MODEL` | quick model 指定的 tokenhub model id（可选） | 从 tokenhub 目录里挑成本最低的模型 |
| `AUTH_GATEKEEPERS` | 设为 `xcity` 启用统一登录 | 上游默认（用户名密码 / Cloudflare Access） |
| `DISABLE_PASSWORD_AUTH` | `true` 时只留 SSO | 保留密码登录 |
| `ADMINS` | 管理员邮箱列表（上游既有，见 `packages/workshop-backend/src/server.ts`） | 无管理员 |

**本仓库不持有 `LITELLM_MASTER_KEY`。** 列 agent 走 xct-home 的公开目录
`GET $XCITY_HOME_URL/api/catalog/agents`（已剥离上游 `apiUrl`），而不是直接查 tokenhub 注册表。

## 与上游同步

```bash
git fetch upstream
git rebase upstream/main        # 冲突应该只可能出现在上表四个接缝点
```

若某次 rebase 在接缝点之外产生冲突，说明有人破坏了上面的约定，应先把改动挪回 `xcity/` 目录。

## 部署

部署源是 `cloudflare-os-starter`，其 `cloudflare-os` submodule 指向本 fork：

```bash
cd /Users/javen/workspace/cloudflare-os-starter
env -u CLOUDFLARE_API_TOKEN pnpm check
env -u CLOUDFLARE_API_TOKEN pnpm deploy
```

`env -u CLOUDFLARE_API_TOKEN` 必须带 —— shell 里有一个 zone-scoped 的弱 token，wrangler 会优先用它而不是 OAuth 登录态。

完整设计见 `~/.claude/plans/foamy-conjuring-kazoo.md`。
