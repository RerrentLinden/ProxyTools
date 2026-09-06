# 来源说明

本目录脚本针对 Surge Mac 重新编写，使用 Surge 原生 API；没有复制或运行上游通用 Env 包装层、Node 依赖或 Bark 推送集成。以下资料用于确认历史存储结构、站点接口、原模块参数及兼容行为。

| 资料 | 用途 |
| --- | --- |
| [Sliverkiss NodeSeek 脚本](https://gist.github.com/Sliverkiss/2b5acc2c4960dd06618c6912302c2c7f) | 账号数组、签到端点、固定／随机奖励模式 |
| [RerrentLinden DeepFlood 脚本](https://gist.github.com/RerrentLinden/91c4db5f85955ed6043829d73fc69f42) | DeepFlood 适配及旧存储键 |
| [imoki/sign_script](https://github.com/imoki/sign_script) 及本仓库旧科研通脚本 | 科研通原始实现来源、登录 Cookie 和签到结果约定 |
| [NobyDa 漫画签到](https://github.com/NobyDa/Script/blob/master/Bilibili-DailyBonus/Manga.js) | 漫画登录态、账号存储和 ClockIn 接口 |
| [NobyDa 漫画积分兑换](https://github.com/NobyDa/Script/blob/master/Bilibili-DailyBonus/ExchangePoints.js) | 商城查询、兑换请求及历史状态 |
| [QingRex/LoonKissSurge](https://github.com/QingRex/LoonKissSurge) | 用户原安装的漫画模块配置及执行时间 |
| [V2EX 日常任务](https://www.v2ex.com/mission/daily) | 当前领取链接结构、临时令牌及已领取状态 |

## Surge 官方接口

- [模块语法](https://manual.nssurge.com/profile/module.html)：参数替换、主机名追加和平台声明。
- [JavaScript API](https://manual.nssurge.com/scripting/api.html)：HTTP、持久化存储、通知及脚本结束。
- [脚本运行与缓存](https://manual.nssurge.com/scripting/overview.html)：引擎、超时、匹配顺序和本地调试缓存。
- [Cron](https://manual.nssurge.com/scripting/cron.html)：执行时间及 `wake-system` 的平台限制。
- [Surge CLI](https://manual.nssurge.com/tools/cli.html)：本机配置检查和脚本执行。

接口细节同时通过用户已登录浏览器和 Surge Mac 实际请求核对。第三方页面或接口变化仍可能需要更新适配；验证记录会区分离线检查与真实账号结果。
