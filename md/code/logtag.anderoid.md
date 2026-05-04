## 安卓 日志 tag 代码
输出日志的代码如下
```
AndroidDebugLogUtil.log("orchestrateDebug", "...");
AndroidDebugLogUtil.log("orchestrateSession", "...");
AndroidDebugLogUtil.log("aiGame][useToonflowStore", "...");
AndroidDebugLogUtil.log("aiGame][runtimeStatus", "...");
AndroidDebugLogUtil.log("aiGame][miniGame", "...");
```
## 编写 日志调试工具
编写日志调试工具 `AndroidDebugLogUtil`
配置 `debug=true`
开启方式：
- SharedPreferences：`debug=true`
- SharedPreferences：`toonflow.debug=true`

说明：
- 只有显式开启 `debug=true` 时才会输出这些调试日志；
- 现有 `[tag_vue] [network]`、`[tag_vue] [voice]` 等日志仍沿用原有 `VueTagLogger`，不受这里控制。
## 安卓 日志 tag （debug=true）
[orchestrateSession] 编排
[orchestrateDebug] 编排-调试
[aiGame][useToonflowStore] 故事游玩和调试 日志
[aiGame][runtimeStatus] 故事游玩和调试 日志-状态流转

[aiGame][miniGame] 故事游玩和调试 日志-小游戏调试信息

### 小游戏全链路打tag
[aiGame][miniGame] 进入小游戏{小游戏名称}
[aiGame][miniGame] 用户发送了信息：
[aiGame][miniGame] 旁白播报-台词
[aiGame][miniGame] 旁白播报-台词-语音播放
[aiGame][miniGame] 敌方回合-编排
[aiGame][miniGame] 敌方回合-台词
[aiGame][miniGame] 敌方回合-语音播放
[aiGame][miniGame] 退出小游戏{小游戏名称}

[aiGame][miniGame] 陪练(狼人杀 挖矿等)角色回合-编排
[aiGame][miniGame] 陪练(狼人杀 挖矿等)角色回合-台词
[aiGame][miniGame] 陪练(狼人杀 挖矿等)角色回合-语音播放
## 安卓端 请求日志
[tag_vue] 模拟浏览器输出日志和变量
[tag_vue] [runtime_chat]
[tag_vue] [story_flow]
[tag_vue] [network]
[tag_vue] [layout]
[tag_vue] [network] [orchestrator]
[tag_vue] [voice]
