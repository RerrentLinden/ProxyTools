# Surge 分流规则集

## 来源

除 `Claude.list`、`AIOther.list` 外，均为 [blackmatrix7/ios_rule_script](https://github.com/blackmatrix7/ios_rule_script) 提交 `0b6897d`（2026-10-28）中 `rule/Surge/<名称>/<名称>.list` 的快照，按 GPL-2.0 许可再分发。之后由本仓库自行维护，不再跟随上游。

文件头保留上游的 `NAME`、`UPDATED`、`TOTAL` 等信息，另加 `SNAPSHOT` 行标明快照来源。本仓库补充的规则一律追加在文件末尾的「ProxyTools 补充」段，上游条目原样保留。

## 本仓库修改

| 文件 | 补充内容 |
| --- | --- |
| `Gemini.list` | Antigravity（`antigravity` 关键字、cloudcode-pa、daily-cloudcode-pa、aicode 等）、Gemini App 后端（robinfrontend-pa 等）、AI Studio、`gemini.google`、NotebookLM、Google Labs、Jules、Flow、Opal；原配置单规则 `withgoogle.com`、`notebooklm.google.com`。域名对照 [v2fly google-deepmind](https://github.com/v2fly/domain-list-community/blob/master/data/google-deepmind) 和本机 Surge 实际请求 |
| `OpenAI.list` | 原配置单规则 `chatgpt.site`、`sora.com` |
| `Copilot.list` | 原配置单规则 `githubcopilot.com` |
| `HBO.list` | 原配置单规则 `discomax.com`（`max.com` 上游已有） |
| `Claude.list` | 本仓库原有；2026-11-13 增加 `stripe.com`、`stripe.network`，使 Stripe 支付与风控走同一出口 |
| `AIOther.list` | 新建：Perplexity、LMArena 等没有独立规则集的 AI 服务 |

`podcasts.apple.com` 已被 `Apple_All_No_Resolve.list` 的 `DOMAIN-SUFFIX,apple.com` 覆盖，不再单列。

## 规则集与策略组

| 规则集 | 本机策略组 |
| --- | --- |
| OpenAI、Claude、Gemini、Copilot、AIOther | AI |
| GlobalScholar | Scholar |
| BiliBili | BiliBili |
| YouTube、Twitch | Media |
| Netflix、Disney、HBO、AmazonPrimeVideo | Stream |
| TikTok | TikTok |
| Telegram | Telegram |
| XiaoHongShu、Twitter、Instagram、Reddit、Discord | SocialMedia |
| GitHub、ProxyLite | PROXY |
| Apple_All_No_Resolve | Apple |
| Microsoft | Microsoft |
| Google | Google |
| WeChat | DIRECT |

「ProxyTools 补充」段同时用于 mihomo 同名规则集（`mihomo-rules/`），修改后运行 `node tools/sync-mihomo-rules.js --write`。

AI 相关规则集必须排在 `Google.list` 之前，否则 Gemini / Antigravity 的 googleapis.com 子域会先命中 Google 组。
