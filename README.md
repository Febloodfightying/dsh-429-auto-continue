# dsh-429-auto-continue

DSH (DeepSeek Harness) 插件：回合因 **HTTP 429 / 限流 / 配额耗尽** 失败结束时，
等待可配置的延迟（默认 10 秒）后自动向同一会话发送「继续任务」——效果等同于
手动输入，任务自动接着跑，不用人守着。

## 定位

这是内置重试链（dsh-llm-retry、dsh-retry-boost 等）之后的**最后一道网**：

- 重试还在进行中 -> 回合没有死 -> 本插件不打扰；
- 重试耗尽 / 不在重试范围内 -> 回合以 429 类失败结束 -> 本插件等 delayMs
  后自动发送「继续任务」。

检测信号：turn/end 失败里 status === 429，或错误码在 codes 白名单
（默认 RATE_LIMIT / QUOTA）。

## 功能

- **总开关**（enable）：关闭后完全不监听、不发送。
- **延迟**（delayMs）：429 后等待多少毫秒再自动发送。
- **发送内容**（message）：自动发送的文本，等效手动输入。
- **错误码白名单**（codes）：逗号分隔；HTTP 429 始终触发，与白名单无关。
  留空则只认 429。
- **排除子会话**（excludeSubagents）：不为后台子任务乱发消息。
- **连续继续次数上限**（maxContinues，默认 3，0 = 不限）：同一会话连续自动
  继续达到上限后停手，防止 429 反复触发时无限循环消耗配额。
- **防打扰**：同会话连续失败只保留最新一个定时器（防抖）；定时期间用户手动输入
  或新回合开始（turn/start）立即取消。
- **设置界面**：在 dsh web 总设置界面注册「429 自动继续」入口，所有配置
  可视化编辑（编辑只在本地草稿，点「保存」一次性写入）。

## 安装

```bash
dsh plugin --profile web add dsh-429-auto-continue
```

或手动放入 profile 的 node_modules 并在 package.json 的
dependencies / dsh.profile.bundles 里登记。装完**重启 DSH** 生效。

## 配置

配置在 dsh web 设置界面（设置 -> 429 自动继续）可视化编辑，写入
cordis.patch.yml。也可直接改 patch：

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| enable | true | 总开关 |
| delayMs | 10000 | 429 后等待毫秒数（0~3600000） |
| message | 继续任务 | 自动发送的文本 |
| codes | [RATE_LIMIT, QUOTA] | 触发错误码白名单 |
| excludeSubagents | true | 排除子会话 |
| maxContinues | 3 | 连续自动继续次数上限（0 = 不限） |

## 开发

```bash
npm run check   # node --check 两个入口
```

## 许可

MIT
