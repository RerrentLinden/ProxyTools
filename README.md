# ProxyTools

## Surge Mac 签到模块

DeepFlood、NodeSeek、科研通、哔哩哔哩漫画签到／积分抢购，以及 V2EX 的模块和全部运行 JS 统一位于 [surge-modules](surge-modules/README.md)。安装方法、浏览器 Cookie 获取和逐站实测结果见该目录；积分兑换默认只读试运行。

## Boil の IP 管理模块

手动查询或更换 Boilcloud VPS 公网 IP。模块不包含定时任务、网络切换事件或面板自动刷新；API 只会在用户点击对应面板刷新按钮时调用。脚本资源自身的定期更新不会调用 Boil API。

- 查询面板由 `query_enabled` 控制。
- 更换面板由默认关闭的 `change_enabled` 安全开关控制。
- API Token 通过 Surge 模块参数填写，不保存在仓库文件中。

文件：

- `boil-ip-manager.sgmodule`
- `boil-ip-manager.js`
