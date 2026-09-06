# Surge Mac 签到模块

六个模块的定义和全部运行脚本均保存在本目录。运行时无需 BoxJS、Node.js、Gist 或其他仓库的 JavaScript。

## 安装

在 Surge 的「模块 → 从 URL 安装模块」中粘贴下表链接。所有模块归入「签到任务」分类。

| 模块 | 安装链接 | 默认执行时间 |
| --- | --- | --- |
| DeepFlood | [deepflood.sgmodule](https://raw.githubusercontent.com/RerrentLinden/ProxyTools/main/surge-modules/deepflood.sgmodule) | 每天 00:05 |
| NodeSeek | [nodeseek.sgmodule](https://raw.githubusercontent.com/RerrentLinden/ProxyTools/main/surge-modules/nodeseek.sgmodule) | 每天 00:05 |
| 科研通 | [sciencehub.sgmodule](https://raw.githubusercontent.com/RerrentLinden/ProxyTools/main/surge-modules/sciencehub.sgmodule) | 每天 00:05 |
| 哔哩哔哩漫画签到 | [bilibili-manga.sgmodule](https://raw.githubusercontent.com/RerrentLinden/ProxyTools/main/surge-modules/bilibili-manga.sgmodule) | 每天 00:05 |
| 哔哩哔哩漫画积分抢购 | [bilibili-manga-exchange.sgmodule](https://raw.githubusercontent.com/RerrentLinden/ProxyTools/main/surge-modules/bilibili-manga-exchange.sgmodule) | 周日、周一 00:00:00–00:00:59，每秒执行 |
| V2EX | [v2ex.sgmodule](https://raw.githubusercontent.com/RerrentLinden/ProxyTools/main/surge-modules/v2ex.sgmodule) | 每天 00:05 |

五个普通签到模块均默认每天 00:05，可分别通过 `cron` 参数修改；积分抢购保留表中的独立默认时段。执行时间使用本机时区。验收环境为 Surge Mac 6.9.0（12250）；Mac 须保持唤醒且 Surge 正在运行。本模块不更改系统电源设置，也不保证关机或休眠期间执行。

## 获取 Cookie

启用模块、Surge 脚本和现有 MITM 功能，浏览器需已信任该 Surge 证书。使用已登录账号的浏览器访问下列页面，再运行相应签到脚本验证。首次捕获会通知凭据已保存或更新；凭据未变化时可能不重复通知。

| 站点 | 访问页面 | 捕获条件 |
| --- | --- | --- |
| DeepFlood | [个人设置](https://www.deepflood.com/setting) | 当前账号信息响应，包含私有资料字段且账号 ID 一致 |
| NodeSeek | [个人设置](https://www.nodeseek.com/setting) | 同上，兼容站点 Service Worker 改写的请求来源 |
| 科研通 | [主页](https://www.ablesci.com/) | 已登录请求中的 `_identity-frontend` 和完整 Cookie |
| 漫画 | [漫画主页](https://manga.bilibili.com/) | `SESSDATA`、`DedeUserID` 及存在时的 `bili_jct` |
| V2EX | [日常任务](https://www.v2ex.com/mission/daily) | 包含 `A2` 的登录 Cookie 和相同浏览器 User-Agent |

凭据只保存在 Surge 本地持久化存储。捕获不修改浏览器请求或响应；账号失效时重新登录并访问上述页面，无需把 Cookie 粘贴到仓库或脚本中。

## 参数

- `cron`：五段或六段 Cron 表达式，修改执行时间。
- Seek 的 `mode`：`fixed` 为固定奖励，`random` 为随机奖励。
- DeepFlood、NodeSeek、科研通和漫画签到的 `capture`／`capture_script`、`mitm`：保留默认值即可；填 `#` 可分别关闭该模块的捕获声明或 MITM 主机名追加。已有其他模块追加的主机名不会因此删除。V2EX 模块仅提供 `cron` 参数。
- 兑换的 `product_name`、`product_num`、`attempts`：商品完整名称、数量上限、最多尝试次数。数量 `0` 表示积分和库存允许的最大值；`attempts` 为 1–100，整次执行仍受 50 秒总时限约束。
- 兑换的 `dry_run`：默认 `true`，只查询商品、库存和积分，不发出兑换请求；明确商品、数量和积分预算后，才设置为 `false` 执行真实兑换。

漫画签到接口要求 `platform=ios`，这是站点 API 的参数约定，脚本本身在 Mac Surge 中运行，凭据可从网页获取。

## 结果与恢复

脚本会区分签到成功、今日已完成、缺少凭据、登录失效、网络错误、站点验证和异常响应。Seek 先读取服务端当日记录，已完成时不再提交领奖请求。HTTP 200 不能单独作为成功依据；V2EX 领取后还会重新读取任务页核验。站点验证拦截不会触发隐藏的浏览器自动化替代流程。

漫画真实兑换前会保存待确认记录。若请求超时、网络中断或响应不明确，后续真实兑换会暂停，防止重复消费。此时先在网站核对交易；确认结果后，仅清理对应账号的 `exchangePending` 字段，保留其他账号和历史。不要直接清空整个存储。进程执行锁 `BILI_COMICS_EXCHANGE_LOCK` 会在 90 秒后失效，待确认交易记录不会因此自动清除。

## 从旧模块迁移

1. 备份旧模块文件、其引用的全部 JavaScript、模块参数及启用状态，保存在仓库之外，再安装新的对应模块。
2. 普通签到默认统一为 00:05，如需其他时间可分别设置 `cron`；保留原捕获开关。旧 Seek 存储中的 `nodeseek_default=true`／`deepflood_default=true` 表示随机奖励，应迁移为 `mode=random`；`false` 对应 `mode=fixed`。
3. 关闭对应旧模块，再验证新模块，避免重复 cron 和捕获规则抢先匹配。
4. 若需回退，关闭新模块，从备份恢复旧模块定义、参数和启用状态，并让其 `script-path` 指向已备份的旧 JavaScript，或已经核对内容的固定提交地址。

漫画旧设置 `ProductName`、`ProductNum`、`ExchangeNum` 分别迁移到 `product_name`、`product_num`、`attempts`；新模块显式参数优先于旧存储值。迁移后先保留 `dry_run=true`，确认商品、数量和预算后才开启真实兑换。

保留旧存储键 `deepflood_data`、`nodeseek_data`、`sciencehubCookie`、`BILI_COMICS_CHECKIN`，漫画两项功能共享账号。科研通新增完整 Cookie 和 User-Agent 辅助键，V2EX 使用独立 `V2EX_CHECKIN`。仓库根目录的三个旧模块 URL 及科研通 JS URL 仍提供兼容入口，其中原有中文参数名不变；旧 Seek 入口省略 `mode`，继续读取原有 `*_default` 设置。

旧兼容 URL 也会随本次发布更新，不能作为原版本备份。回退必须同时恢复模块定义和所依赖的旧脚本内容；仅换回旧 URL 不会恢复旧实现。

## 开发验证

在仓库根目录执行：

```sh
node --test tests/surge-checkin-*.test.js
node tests/validate-surge-modules.js
node tests/sync-legacy-checkins.js --check
```

正式源文件修改后，用 `node tests/sync-legacy-checkins.js --write` 更新兼容入口。原生验证配置可通过 `node tests/validate-surge-modules.js --profile-dir /tmp/proxytools-surge-check` 生成，再逐个运行 `surge-cli --check`。

真实验证结果见 [验证记录](VALIDATION.md)，协议依据和来源见 [来源说明](SOURCES.md)。
