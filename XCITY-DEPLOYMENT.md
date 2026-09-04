# 部署状况与优化策略（fork 专属）

审计时间：2026-09-04。审计范围：`XcityUS/xct-os`(本仓) + `XcityUS/xct-os-starter`(部署源)。
本文档描述**部署链路**；改动边界见 [XCITY-INTEGRATION.md](./XCITY-INTEGRATION.md)，
仓库工作方式见 [AGENTS.md](./AGENTS.md)。

> `XCITY-HANDOFF.md`（2026-08-07）中"`xcity.enabled` 仍是 false / 全部休眠 / 本地 laptop 部署"
> 的描述已经过时，见下文「一、部署链路」与「二、线上配置」。

---

## 一、部署链路

```
XcityUS/xct-os (本仓, main)
        │  git submodule "cloudflare-os"
        ▼
XcityUS/xct-os-starter (私有)
        │  .github/workflows/deploy.yml  —— 仅 workflow_dispatch 手动触发
        ▼
Cloudflare account 573fde97…   →  os.xcity.ai
```

部署一次会按顺序发布 7 个 Worker（`scripts/deploy.mjs`）：

| 顺序 | Worker | 来源 |
|---|---|---|
| 1 | `xct-os-error-reporter` | starter |
| 2 | `xct-os-context` | 本仓 `gatekeeper-context` |
| 3 | `xct-os-gatekeeper-custom` | starter |
| 4 | `xct-os-gatekeeper-xcity` | 本仓 |
| 5 | `xct-os-gatekeeper-mcp-portal` | 本仓 |
| 6 | `xct-os-gatekeeper-google` | 本仓 |
| 7 | `xct-os-workshop`（持有全部 service binding，最后发布） | 本仓 |

单次 Deploy 运行约 5 分钟（build + test + 7 次 `wrangler deploy`）。
历史 15 次运行，第 6 次以后全部成功。

**Deploy 是顺序执行、无回滚、无部署后校验的**：若第 7 步失败，前 6 个 Worker 已经上线，
线上处于混合版本状态，且没有任何自动信号会告诉你这件事。

## 二、线上配置（starter `deployment.jsonc`）

| 项 | 状态 |
|---|---|
| `xcity.enabled` | **true** —— Xcity SSO 已点亮，`disablePasswordAuth: true` |
| tokenhub / wallet / home / media URL | 四个全部已配置 |
| `mcpPortal` | enabled，`auth: "oauth"`，显示名 "Xcity Tools" |
| `google` | enabled |
| `aiGateway` | disabled（推理全部走 tokenhub） |
| `access` (issuer/audience) | 仍在配置里，但与 xcity 模式互斥，实际不生效 |
| `observability` | enabled，head sampling 1.0，invocation logs 关闭，traces 关闭 |
| `errorReporting` | enabled，**`release: null`** |

## 三、版本落差（当前最重要的事实）

| 位置 | 提交 | 时间 |
|---|---|---|
| **生产实际运行** | `bbc7873` | 2026-09-02 04:46 部署 |
| starter 已 pin、**未部署** | `25bc147` (PR #21) | 2026-09-02 14:05 合并 |
| 本仓 `main` | `b09219c` (PR #22/#23/#24) | 2026-09-04 06:16 合并 |

**生产落后 main 共 4 个合并提交。** 其中 PR #21「Stop registering OAuth forwarding bindings as
gatekeeper vendors」已经 pin 进 starter 却从未按下 Deploy —— 也就是说线上用户此刻仍会在
Connectors 页看到 `Some services are temporarily unavailable: xcity_http`，
后端每次打开工作区仍记录一条 `vendor.describe.failed`。修复躺在部署门口三天。

## 四、CI 状况（本仓）

- `ci.yml` 只有 Lint 与 Build-and-test 两个 job，绿灯耗时约 2 分 45 秒，不承担任何部署职责。
- 2026-09-01 13:41 → 2026-09-04 06:19，`main` **连续 6 次红 + 1 次挂死**，约 2.7 天无绿构建。
  期间产线照常部署（Deploy 自己会跑 `pnpm run check`，所以红 main 没有直接放行坏代码，
  但也意味着 CI 信号在那三天里完全失去了把关意义）。
- run 29/30 的 Test 步骤挂死 19 分钟后被取消 —— 正是 `ci.yml` 注释里预警过的
  "wedged test process" 模式，`timeout-minutes: 20` 是唯一兜底。
- `ci.yml` **没有 `concurrency` 组**：同一 PR 连推多次，旧 run 不会被取消。
- `pnpm test` 是 `node --test 'scripts/**/*.test.ts' && vp run … test`：
  **scripts 套件一失败，整个 workspace 包测试就不执行**。9-04 04:57 那次红只跑了 3 秒，
  所有包测试都没跑到。
- `preview.yml` 的 deploy / cleanup / sweep 三个 job 全部带
  `if: github.repository_owner == 'cloudflare'` → **在本 fork 永不运行**。
  上游约 1,600 行的预览部署基础设施（`scripts/preview/`）完全闲置，PR 没有任何预览环境。
- 遗留的 draft PR #7（2026-08-14「Fix Xcity OAuth popup hangs」）内容已被 `2e4a5ee` 取代，可关闭。

---

## 五、三个真实缺陷

### P0-1 · MCP Portal 在生产就没接通，而下次部署会把它从"静默错"变成"硬崩"

三处叠加：

1. **BASE_URL 从未下发。** `deploy.mjs` 给 xcity（第 519 行）和 google（第 552 行）
   都写了 `BASE_URL`，唯独 mcpPortal（第 535–541 行）只写 `MCP_PORTAL_URL/NAME/AUTH`。
   生产运行的 `bbc7873` 版本里 `getBaseUrl()` 会 fallback 到
   `http://localhost:8787/gatekeeper/mcp-portal`，而 `portal.ts:305` 用它生成用户看到的
   OAuth 发起链接、`:371` 把它返回给 UI —— 也就是 "Xcity Tools" 的授权入口指向 localhost。
2. **下次部署会变成抛错。** main 上的 `fda4c85`（PR #22）把该 fallback 改成了 `throw`。
   一旦 starter bump 到 `b09219c` 再部署，portal 的每次调用都会失败。
   **先修 starter，再 bump —— 顺序反了就是一次线上事故。**
3. **即便补上 BASE_URL 也还不够。** 每个 gatekeeper Worker 都是 `workers_dev: false`、无 route，
   唯一的对外通路是 workshop 按 `GATEKEEPER_<NAME>_HTTP` 绑定转发 `/gatekeeper/<name>/*`
   （`workshop-backend/src/server.ts:850-854`）。`deploy.mjs` 只建了
   `GATEKEEPER_XCITY_HTTP`（第 460 行）和 `GATEKEEPER_GOOGLE_HTTP`（第 475 行），
   **没有 `GATEKEEPER_MCP_PORTAL_HTTP`**。

修法在 starter 仓，约 6 行：mcpPortal 的 `vars` 加
`BASE_URL: ${workshopBaseUrl(config)}/gatekeeper/mcp-portal`，
`workshop.services` 加 `GATEKEEPER_MCP_PORTAL_HTTP` 绑定（`/gatekeeper/*` 已在
`run_worker_first` 里，无需再改）。

> 这与 `XCITY-HANDOFF.md` 第 2 节的 tokenhub `PROXY_BASE_URL` 是**两个独立**的阻塞项。
> 两个都修好，Xcity Tools 才真的可用。

### P0-2 · 已修复的用户可见 bug 停在部署门口

见「三、版本落差」。根因不是技术问题，是流程问题：bump submodule 和触发 Deploy 是两个
互相独立的人工动作，没有任何东西提醒"pin 了但没发"。

### P1 · 部署无版本可追溯

`errorReporting.release` 是 `null`，所以后端错误报告没有版本维度；
而前端已经通过 `buildStampVars()` 拿到了 submodule short SHA 并显示在 sidebar。
同一次部署，前端知道自己是哪个版本，后端不知道。

---

## 六、优化策略（按 ROI 排序）

### A. 立刻可做（<1 天，零架构改动）

| # | 动作 | 落点 |
|---|---|---|
| A1 | **先**修 starter 的 MCP portal 接线（P0-1 的 BASE_URL + `_HTTP` 绑定），**再** bump submodule 到 `b09219c`，一次部署把 4 个提交送上产线 | starter `scripts/deploy.mjs` + submodule |
| A2 | `errorReporting.release` 改为部署时注入 submodule short SHA（`buildStampVars()` 已经拿到了这个值） | starter |
| A3 | `ci.yml` 加 `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: ${{ github.event_name == 'pull_request' }} }` | 本仓 |
| A4 | 清理常年不跑的继承 workflow：`preview.yml`（org 门锁死）、`bonk.yml`/`bonk-pr.yml`（已是 workflow_dispatch 空壳）—— 要么改 org 门启用，要么删掉，别留着误导 | 本仓 |
| A5 | 关闭 stale draft PR #7 | GitHub |

### B. 短期（1–2 周）：把部署变成可验证的流水线

- **B1 · starter 加 PR CI。** 现在 bump PR 没有任何校验，问题只在点了 Deploy 之后才暴露。
  对 bump PR 跑 `pnpm run check`（build + test + `wrangler deploy --dry-run`）即可。
- **B2 · Deploy 后加冒烟检查。** 部署完 curl `https://os.xcity.ai/` 断言 200，
  并断言页面 build stamp 的 commit 等于本次 submodule SHA。
  7 个 Worker 顺序上线、无回滚，这是最低成本的"部署真的成功了吗"信号。
- **B3 · 自动 bump。** main 绿灯后自动向 starter 开 bump PR（带提交摘要），
  人只负责 review + dispatch。把 P0-2 这类"漏部署"从流程里消掉。
- **B4 · 拆测试 job。** `scripts` 套件与 workspace 套件拆成两个并行 job，互不遮蔽；
  给 `node --test` 加 `--test-timeout`，杜绝 19 分钟挂死。

### C. 中期（1 个月）：预览环境 + 可回滚发布

- **C1 · 复活预览部署。** 把 `preview.yml` 三处 `github.repository_owner == 'cloudflare'`
  改成 `'XcityUS'`，配齐 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` /
  `PREVIEW_ADMINS` / `CF_ACCESS_*` secrets。
  **但注意**：`scripts/preview/staging-config.ts` 的 `backendSecrets()` 只认识
  `ADMINS` / `CF_ACCESS_*` / `CF_AI_GATEWAY_*`，**完全不认识 `XCITY_*`**。
  照搬只能得到"上游模式"预览，验证不了八个接缝里的任何一个。
  真正要做的是给 `staging-config.ts` 加一段 Xcity 变量注入，让预览跑在 xcity 模式。
  这是**唯一**能在合并前发现 P0-1 这类接线问题的手段。
- **C2 · 版本化回滚。** 目前回滚 = 改 pin + 跑一次全量部署（~5 分钟，7 个 Worker 逐个覆盖）。
  改用 `wrangler versions upload` + `versions deploy` 可以拿到秒级回滚与灰度发布，
  优先给 `xct-os-workshop` 做。
- **C3 · 密钥治理。** `CLIENT_ID`/`CLIENT_SECRET`（xcity、google）与 `WALLET_SERVICE_TOKEN`
  全靠人手 `wrangler secret put`，无轮换记录、无缺失检查。
  `deploy.mjs` 已经把它们声明在 `secrets.required` 里，部署前用 `wrangler secret list`
  断言存在即可，成本很低。

### D. 长期：控制 fork 分叉成本

- **D1 · 量化接缝漂移。** `XCITY-INTEGRATION.md` 的接缝表写 8 处，
  实际有 **35 个上游文件**带 xcity 引用（13 个后端 src、10 个前端、12 个测试）。
  建议每次 rebase 前统计这个数并写进同步记录；它增长时就是该把逻辑往
  `workshop-backend/src/xcity/` 收的信号。
- **D2 · 恢复上游同步节奏。** 同步记录停在 2026-08-26，建议回到 1–2 周一次。
  （本次审计未能访问 `cloudflare/cloudflare-os`，当前分叉量未测量。）
- **D3 · 回推 `_HTTP` 跳过。** `auth-vendors.ts` 里跳过 `_HTTP` 后缀是唯一一处非门控的上游改动，
  已由 PR #21 落地，应择机回推上游，减少一个永久冲突点。
- **D4 · 文档去矛盾。** `XCITY-HANDOFF.md` 停在 2026-08-07，其中「`xcity.enabled` 仍是 false」
  「休眠中」「PR #2/#3 待合并」以及本地 laptop 部署命令
  （`cd /Users/javen/workspace/...`）全部与现状矛盾。应重写或明确标注 superseded。
