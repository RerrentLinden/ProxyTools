# ProxyTools

## 目录

| 目录 | 内容 |
| --- | --- |
| [surge-modules](surge-modules/) | Surge 模块（`.sgmodule`），签到模块说明见 [surge-modules/README.md](surge-modules/README.md) |
| [surge-scripts](surge-scripts/) | 模块引用的 JavaScript |
| [surge-rules](surge-rules/) | Surge 分流规则集（`.list`），来源与修改见 [surge-rules/README.md](surge-rules/README.md) |
| [mihomo-rules](mihomo-rules/) | Clash / mihomo 内核用的 YAML 规则集，来源见 [mihomo-rules/README.md](mihomo-rules/README.md) |
| [tools](tools/) | 维护脚本（把 Surge 规则集的补充同步到 mihomo yaml） |
| [tests](tests/) | 离线测试，仓库根目录执行 `node --test tests/*.test.js` |

## 模块安装

在 Surge「模块 → 从 URL 安装模块」中粘贴链接。

| 模块 | 安装链接 |
| --- | --- |
| po0 防火墙自动加白 | `https://raw.githubusercontent.com/RerrentLinden/ProxyTools/main/surge-modules/po0-firewall-whitelist.sgmodule` |
| Boil の IP 管理 | `https://raw.githubusercontent.com/RerrentLinden/ProxyTools/main/surge-modules/boil-ip-manager.sgmodule` |
| 机场流量信息 | `https://raw.githubusercontent.com/RerrentLinden/ProxyTools/main/surge-modules/DualAirportinfo.sgmodule` |
| 签到模块（6 个） | 见 [surge-modules/README.md](surge-modules/README.md) |

## 分流规则集

Surge：`RULE-SET,https://raw.githubusercontent.com/RerrentLinden/ProxyTools/main/surge-rules/<名称>.list,<策略>,no-resolve`

mihomo：`https://raw.githubusercontent.com/RerrentLinden/ProxyTools/main/mihomo-rules/<名称>.yaml`，`behavior: classical`。来源与维护方式见 [mihomo-rules/README.md](mihomo-rules/README.md)。

## 2026-11-13 链接迁移

根目录旧链接已删除，仍在使用的设备请改用新链接：

| 旧路径 | 新路径 |
| --- | --- |
| `Claude.list` | `surge-rules/Claude.list` |
| `Claude.yaml` | `mihomo-rules/Claude.yaml` |
| `Claude_No_Resolve.yaml` | `mihomo-rules/Claude_No_Resolve.yaml` |
| `po0-firewall-whitelist.sgmodule` | `surge-modules/po0-firewall-whitelist.sgmodule` |
| `boil-ip-manager.sgmodule` | `surge-modules/boil-ip-manager.sgmodule` |
| `DualAirportinfo.sgmodule` | `surge-modules/DualAirportinfo.sgmodule` |
| `po0-firewall-whitelist.js`、`boil-ip-manager.js`、`surge-modules/scripts/*.js` | `surge-scripts/*.js` |
| `deepflood.sgmodule`、`nodeseek.sgmodule`、`科研通自动签到.sgmodule`、`sciencehub-script.js` | 已删除，改装 `surge-modules/` 下的对应模块 |

在 Surge 中改模块链接会被视为新模块，模块参数（如 token）需要重新填写。

## Boil の IP 管理模块

手动查询或更换 Boilcloud VPS 公网 IP。模块不包含定时任务、网络切换事件或面板自动刷新；API 只会在用户点击对应面板刷新按钮时调用。脚本资源自身的定期更新不会调用 Boil API。

- 查询面板由 `query_enabled` 控制。
- 更换面板由默认关闭的 `change_enabled` 安全开关控制。
- API Token 通过 Surge 模块参数填写，不保存在仓库文件中。

### 更换时为什么会断网

官方换 IP 的机制是让路由器（iKuai）的 WAN 线路重连／重拨，重连期间 VPS 没有公网连接。这是官方机制，脚本无法消除；脚本每次点击只提交一次与官方文档等价的 `changeIP` 请求。重拨后也可能分回同一个 IP。

### 更换流程与确认

1. 先用 `getIP` 记录旧 IP；查询失败则不提交更换。
2. 只提交一次 `changeIP`。网络错误、超时、HTTP 5xx、非 JSON 或“內部錯誤”视为结果不明确：不重复提交，直接进入确认。
3. 提交后第 10、20、30、45、60、80、100、120…240 秒（不超过 `confirm_seconds`）轮询 `getIP`：IP 变化即显示旧 IP、新 IP 和确认耗时；窗口结束仍为旧 IP 则显示“未变化”，不会自动再换。等待期间面板保持刷新状态。
4. `confirm_seconds=0` 时提交后立即返回，1–3 分钟后点「Boil IP 查询」确认。查询面板会对比最近一次更换记录，显示是否已从旧 IP 变化。

`confirm_seconds` 模块默认 120，可设 0–240（超出按 240 处理）；更换脚本 `timeout=300`，覆盖最长等待。旧版模块（`timeout=20`、无此参数）加载新脚本时按 0 处理，不等待确认。

### 本地保护（不请求 API、不扣次数）

- 官方返回的下次可用时间（成功响应或“頻率限制中”错误中的时间戳）未到时，直接拦截。
- 上一次更换仍在提交／确认中，或提交结果不明确后的 5 分钟保护期内，拦截再次提交。结果不明确但随后确认 IP 已变化时，官方冷却时间未知，保护期照常保留。
- 官方下次可用时间超过 24 小时以后的异常值不参与拦截，避免本地被错误数据锁死。
- 面板自动刷新（`$trigger` 为 `auto-interval`）不会触发更换。

官方规定频率限制、当日次数用完、机器不允许更换时调用仍扣 1 次 API，面板会注明，请勿重复点击；Token 失效（用戶與機器不匹配）需到 ippanel.boil.network 重新获取。本地记录保存在 Surge 持久化存储键 `boil_ip_manager_state_v1`，只含 IP、时间戳和 Token 指纹，不含 Token。

文件：

- `surge-modules/boil-ip-manager.sgmodule`
- `surge-scripts/boil-ip-manager.js`
