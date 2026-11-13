# mihomo 分流规则集

均为 `behavior: classical` 格式，IP 规则已带 `no-resolve`。

## 来源

| 文件 | 来源 |
| --- | --- |
| `Claude.yaml`、`Claude_No_Resolve.yaml` | 本仓库手写，两份内容相同（后者保留旧名称），测试检查与 `surge-rules/Claude.list` 一致 |
| `AIOther.yaml` | 由 `surge-rules/AIOther.list` 整份生成 |
| 其余 | [blackmatrix7/ios_rule_script](https://github.com/blackmatrix7/ios_rule_script) 提交 `0b6897d`（2026-10-28）中 `rule/Clash/<名称>/<名称>_No_Resolve.yaml` 的快照，按 GPL-2.0 许可再分发，此后由本仓库维护 |

快照直接收录上游的 Clash 版本，没有由 Surge 版转换：上游 Clash 版与 Surge 版并不完全相同（例如 Netflix、WeChat 的 Clash 版 IP 段少得多，Google、Telegram 的 Clash 版带 Windows 进程名）。`Apple.yaml` 对应上游 `Apple_No_Resolve.yaml`（不是 Surge 用的 `Apple_All`）。

## 本仓库补充

补充规则只在 `surge-rules/<名称>.list` 末尾的「ProxyTools 补充」段维护。修改后运行：

```sh
node tools/sync-mihomo-rules.js --write
```

脚本会把该段同步到同名 yaml 的末尾，并在文件头加 `MODIFIED` 标记；测试检查两边是否一致。目前有补充的：`OpenAI`、`Copilot`、`Gemini`、`HBO`。
