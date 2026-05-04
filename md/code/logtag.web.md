## web 日志 tag 代码
输出日志的代码如下
```
console.log("[orchestrateDebug] result");
console.log(result);

console.log("[orchestrateSession] result");
console.log(result);

console.log("[aiGame][useToonflowStore]");

console.log("[aiGame][runtimeStatus] runtimeStatus");
```
## 编写 日志调试工具
编写 日志调试工具 WebDebugLogUtil
配置 debug=true
开启方式：
- URL 参数：`?debug=true`  http://localhost:5173/?debug=true
- localStorage：`debug=true`
- localStorage：`toonflow.debug=true`
## web 日志 tag （debug=true）
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