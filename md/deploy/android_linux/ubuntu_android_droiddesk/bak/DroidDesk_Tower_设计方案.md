# DroidDesk Tower 设计方案

> 目标：在 Android + proot Ubuntu 环境里，提供一套**可靠的** Web 运维面板（类宝塔），
> 彻底替代 tower-pm2 / supervisor 这类在 proot 下不可靠的 daemon 方案。
>
> 文档中所有结论均在真机（PLU110 / 192.168.31.66）实测验证，非推测。

---

## 一、结论先行：为什么必须放弃 tower-pm2 和 supervisor

### 1.1 现象

| 入口 | `tower-pm2 status` 结果 |
|---|---|
| SSH（PuTTY / WinSCP） | ✅ 看到 `toonflow-game` |
| DroidDesk 的「ubuntu shell」按钮 | ❌ **空表格**，且提示 `Spawning tower-pm2 daemon` |

### 1.2 真机实测（决定性）

用 `adb shell run-as com.orailnoor.droiddesk` 在**宿主侧**起一个与「ubuntu shell 按钮」
完全等价的 proot 容器，在容器内执行：

```
rpc.sock exists : NO           # SSH 容器里是 YES
node connect    : FAIL ENOENT  # SSH 容器里是 OK
tower-pm2 status      : [tower-pm2] Spawning tower-pm2 daemon ... 空表格
```

**根因：unix domain socket 只在创建它的那个 proot 实例内可见。**

`sshd` 与 tower-pm2 daemon 恰好同在 proot #2 实例内，所以 SSH 看得到；
App shell 是另一个实例，看不到 `rpc.sock`，于是 tower-pm2 自行 spawn 一个**全新的空 daemon**。

### 1.3 回答两个常见误解

| 猜测 | 判定 | 说明 |
|---|---|---|
| 「有其他非 DroidDesk 安装的 proot 容器，删掉即可」 | ❌ | 设备上 3 个容器**全部**由 DroidDesk 自己创建，不存在第三方容器 |
| 「只是多 PID 的问题」 | ❌ | proot 共享宿主 PID namespace，各实例本就能互相看见进程（实测 `/proc/12149` 跨实例 VISIBLE）。问题**只在 unix socket** |

### 1.4 脆弱性实证

仅执行**一次只读**的 `tower-pm2 status`（无任何写操作），即打崩原 daemon 15167 与业务进程 15279，
30 秒后才被看门狗自动 resurrect 恢复。这套机制经不起任何触碰。

---

## 二、设计铁律：proot 跨实例通道能力表

这是整个 Tower 方案的技术地基，**实测得出**：

| 通道 | 跨 proot 实例 | 能否用于状态共享 |
|---|---|---|
| unix domain socket | ❌ 不可见 | **禁用** —— tower-pm2 / supervisor / 任何 daemon+socket 方案 |
| TCP（127.0.0.1 / 局域网） | ✅ 通（实测 7088→200） | **Tower 的唯一通信方式** |
| `/proc/<pid>` | ✅ 可见（uvicorn 12149、nginx 12146 跨实例 VISIBLE） | **进程存活判定的唯一真相源** |
| 普通文件（pid / 日志 / 配置） | ✅ 共享（`/run/tower/*.pid` 可写） | **状态持久化** |

> 补充：Python 走 `statx` 在 proot 下对 AF_UNIX 返回 `EINVAL(code 22)`，
> 所以 `supervisorctl` 即便 socket 存在也必然失败 —— supervisor 是**双重不可用**。

**推论：proot 环境下，可靠的进程管理必须是「无 daemon」架构
= TCP 通信 + pid 文件 + /proc 校验。**

---

## 三、架构选型：为什么 tower-pm2 而非 tower-pm2

### 方案 A：直接用 tower-pm2（不推荐）

| 维度 | 分析 |
|---|---|
| **原理** | tower-pm2 作为独立守护进程运行，Tower Panel 通过 CLI（`tower-pm2 start/stop/restart/status`）或 HTTP API 与其交互 |
| **单实例限制** | tower-pm2 原生设计支持 `--instances 1` 到多实例，进程模型复杂 |
| **多 PID 共享问题** | tower-pm2 的"重启即 fork 新进程"模型会导致 PID 不断跳动，不好追踪 |
| **运行时依赖** | tower-pm2 是 Node.js 工具，服务是 Python，环境异构增加了部署复杂度 |
| **集成难度** | 需要解析 tower-pm2 的 `list` JSON 输出来展示状态，耦合度高 |

**结论：不推荐直接用 tower-pm2。**

### 方案 B：自研 tower-pm2（推荐）

| 维度 | 分析 |
|---|---|
| **原理** | `tower-pm2` 作为一个**单实例**守护进程，管理所有注册的 Service，每个 Service 严格一个 PID |
| **单实例保证** | 架构本身保证：一服务一名只对应一个 PID，启动前检查是否已有运行中的 PID |
| **轻量** | 不需要 Node.js 运行时，纯 Python（与 Tower Panel 技术栈一致），依赖少（仅 psutil） |
| **深度集成** | 进程管理器与 Panel 共用同一个 Service Registry（JSON），状态完全可控 |
| **功能裁剪** | 不需要 tower-pm2 的 cluster、load balancing、ecosystem 等复杂功能，只需要 start/stop/restart/status/auto-restart |
| **日志** | stdout/stderr 重定向到文件 + 日志轮转，代码量约 500 行 |

**结论：推荐自己开发 tower-pm2。**

---

## 四、Tower 架构

```
Android 宿主
└─ DroidDesk App（前台服务保活）
     └─ 唯一常驻 proot Ubuntu 容器
          ├─ tower-pm2 :7088        单实例 Python 守护进程，无 unix socket
          │    ├─ HTTP API（start/stop/restart/list/add/delete/system）
          │    ├─ 内嵌宝塔风 Web UI
          │    ├─ 读 /run/tower/*.pid + /proc/<pid>/cmdline → 真实状态
          │    ├─ keep_live 自动重启（防抖：5 分钟内重启超 5 次则 crash_loop）
          │    ├─ 日志看护（单文件 > 100MB 即 truncate）
          │    └─ 配置：/etc/tower/services.json（纯文件，无 daemon）
          ├─ sshd :8122
          ├─ nginx :8088
          └─ 业务进程（python3 -m panel --port 60002 …）
```

四个入口全部是**客户端**，不再自己起服务：

| 入口 | 方式 | 通道 |
|---|---|---|
| DroidDesk App 内嵌页 | WebView 访问 `http://127.0.0.1:7088` | TCP ✅ |
| PC 浏览器 | `http://192.168.31.66:7088` | TCP ✅ |
| SSH / PuTTY | `curl -s http://127.0.0.1:7088/api/list` | TCP ✅ |
| ubuntu shell 按钮 | 同上 | TCP ✅ |

**关键：全部走 TCP，绕开 unix socket —— 这是四个入口能看见同一份状态的唯一原因。**

---

## 五、服务注册表（/etc/tower/services.json）

```json
{
  "services": [
    {
      "name": "toonflow-game",
      "cmd": "cd /opt/toonflow/panel && python3 -m panel --port 60002",
      "cwd": "/opt/toonflow/panel",
      "stdout_log": "/var/log/tower/toonflow-game.out.log",
      "stderr_log": "/var/log/tower/toonflow-game.err.log",
      "keep_live": true,
      "start_with_os": false,
      "start_nginx_with_ubuntu": false
    },
    {
      "name": "sshd",
      "cmd": "/usr/sbin/sshd -D",
      "cwd": "/",
      "stdout_log": "/var/log/tower/sshd.out.log",
      "stderr_log": "/var/log/tower/sshd.err.log",
      "keep_live": true,
      "start_with_os": false,
      "start_nginx_with_ubuntu": false
    },
    {
      "name": "nginx",
      "cmd": "nginx",
      "cwd": "/",
      "stdout_log": "/var/log/tower/nginx.out.log",
      "stderr_log": "/var/log/tower/nginx.err.log",
      "keep_live": true,
      "start_with_os": false,
      "start_nginx_with_ubuntu": false
    }
  ]
}
```

关键字段说明：

| 字段 | 含义 |
|---|---|
| `keep_live` | 进程死后自动重启（防抖：5 分钟内超过 5 次则标记 `crash_loop` 停止重试） |
| `start_with_os` | 开机自启（未来 systemd/init.d 扩展用） |
| `start_nginx_with_ubuntu` | 随 Ubuntu 启动时同步启动 nginx |

---

## 六、Tower API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 宝塔风 Web UI |
| GET | `/api/list` | 全部服务状态（pid / 存活 / CPU / 内存 / uptime / 重启次数） |
| GET | `/api/system` | CPU 核数 / 内存 / 磁盘 / 负载 / 系统运行时长 |
| POST | `/api/start/<name>` | 启动服务 |
| POST | `/api/stop/<name>` | 停止服务 |
| POST | `/api/restart/<name>` | 重启服务 |
| POST | `/api/delete/<name>` | 删除服务（先停再删配置） |
| POST | `/api/add` | 添加服务（body: JSON，含 name/cmd/cwd/keep_live/start_nginx_with_ubuntu） |
| POST | `/api/refresh` | 刷新所有服务状态 |

状态字段从 `/proc` 实时读取，不缓存、不依赖任何 daemon。

---

## 七、文件布局

```
/opt/droiddesk/tower/          # Tower 程序目录（DroidDesk 命名空间）
  tower-pm2.py                 # 主程序（单实例守护进程）
  tower-start                  # 启动脚本
  tower-stop                   # 停止脚本
  tower-list                   # 状态查看脚本
  install.sh                   # 安装脚本
  uninstall.sh                 # 卸载脚本

/etc/tower/
  services.json                # 服务注册表

/run/tower/
  tower-pm2.pid                # tower-pm2 自身 PID
  <service>.pid                # 各服务 PID

/var/log/tower/
  tower-pm2.log                # tower-pm2 主日志
  <service>.out.log            # 各服务 stdout
  <service>.err.log            # 各服务 stderr
```

---

## 八、对现有部署的改造清单

目标目录：`..`

| 文件 | 现状 | 改造 |
|---|---|---|
| `bak/tower/tower-agent.py` | 旧版 tower-agent（FastAPI） | ❌ 废弃 → ✅ 替换为 `tower-pm2.py`（单实例 daemon） |
| `tower/services.json` | 旧格式（key-value map） | ✅ 新格式（array + keep_live/start_nginx_with_ubuntu） |
| `tower/tower-start` | 基于 jq 读旧格式 | ✅ 重写（适配新 services.json） |
| `tower/tower-stop` | 同上 | ✅ 重写 |
| `tower/tower-list` | 同上 | ✅ 重写（Python + psutil） |
| `tower/install.sh` | 依赖 tower-pm2 | ✅ 重写（部署 tower-pm2 + services.json + 启动） |
| `tower/uninstall.sh` | 无 | ✅ 新增 |

**DroidDesk App 侧**

| 位置 | 改造 |
|---|---|
| `LinuxRuntime.kt` 的 Tower 方法 | `tower-agent.py` → `tower-pm2.py`，PID 文件名同步更新 |
| Flutter assets | 删除 `tower-agent.py`，新增 `tower-pm2.py`、`../install.sh`、`uninstall.sh` |
| `pubspec.yaml` | 注册 `assets/tower/`（含新增文件） |
| `platform_bridge.dart` | 7 个 Tower 方法不变（API 不变） |
| LIFECYCLE 区域（已清理） | 删除了 tower-pm2 / supervisor 三个 SwitchListTile |

---

## 九、落地步骤

| 阶段 | 动作 | 风险 |
|---|---|---|
| S1 | 编译 DroidDesk APK（`flutter build apk --debug`） | 无 |
| S2 | 真机装 APK → 调用 `DroidDeskPlatform.installTower()` | 无 |
| S3 | PC 浏览器打开 `http://192.168.31.66:7088` 验 Web UI | 无 |
| S4 | 验 start/stop/restart/add/delete 服务操作 | 无 |
| S5 | 验 keep_live 自动重启（手动 kill 服务进程） | 无 |
| S6 | 验 crash_loop 防抖（快速 kill 5 次以上） | 无 |
| S7 | 四入口一致性：App WebView / PC 浏览器 / SSH curl / ubuntu shell 按钮 | 无 |

---

## 十、配套问题：nginx epoll 报错与 15GB 日志失控

### 10.1 现象与实测

```
2026/09/06 01:51:55 [alert] 19673#19673: epoll_wait() failed (38: Function not implemented)
```

- `38 = ENOSYS`：**proot 未实现 nginx 实际调用的那个 epoll syscall 变体**（多为 `epoll_pwait2`）。
- 报错 pid 19673/19674 属**旧 nginx 实例**；当前实例 12146（01:51 之后由 supervisor 重建）已不再报错 → **偶发**，与具体 proot 实例/启动参数相关。
- 服务本身仍正常（8088→200、7088→200）。

### 10.2 真正的危害：15GB 日志

```
/var/log/nginx/error.log   15G
磁盘 219G / 已用 149G / 可用 71G (68%)
```

暴增原因链条：

```
proot syscall 覆盖不全 (epoll_wait ENOSYS)
   ↓ nginx 事件循环疯狂刷 alert
   ↓ 容器里既无 cron 也无 logrotate
   ↓ error.log 无限增长到 15G
```

**结论：这个容器里没有任何定时任务机制。**

### 10.3 处理步骤

**立即（一次性，释放 15G）**

```bash
# 1) 先留一份尾部证据
tail -1000 /var/log/nginx/error.log > /root/nginx-error.tail.log

# 2) truncate 而非 rm —— nginx 持有 fd，rm 不会释放空间
: > /var/log/nginx/error.log

# 3) 让 nginx 重新打开日志句柄
nginx -s reopen 2>/dev/null || kill -USR1 $(cat /run/nginx.pid)

# 4) 验证
df -h / ; stat -c '%s' /var/log/nginx/error.log
```

**规避 epoll（根治报错）**

`/etc/nginx/nginx.conf`：

```nginx
events {
    use poll;              # 关键：绕开 proot 不支持的 epoll 变体
    worker_connections 768;
}
```

```bash
nginx -t && nginx -s reload
```

> poll 吞吐低于 epoll，但该场景（个人服务器、并发极低）完全够用。
> 若 `nginx -t` 报 `unknown directive "use poll"`，改用 `use select;`。

**降低噪音（可选）**

```nginx
error_log /var/log/nginx/error.log crit;
```

### 10.4 tower-pm2 内置日志看护

tower-pm2 的后台线程每 60 秒巡检 `/var/log/tower/` 下所有日志文件，
单文件超过 100MB 即 truncate（保留尾部 2000 行），不依赖 cron/logrotate。

---

## 十一、Tower Web UI 设计

参考宝塔风格，单实例、多服务一表展示：

```
┌────────────────────────────────────────────────────────────────────┐
│ DroidDesk Tower   [进程管理器]                        端口 7088    │
├────────────────────────────────────────────────────────────────────┤
│ [+ 添加服务]  [刷新]                              3 服务 · 2 在线  │
├────────────────────────────────────────────────────────────────────┤
│ 名称           状态       PID    运行时长  CPU   内存    重启次数  │
│ toonflow-game  🟢 online  12149  2h15m     3.2%  145MB   0       │
│ sshd           🟢 online  12201  2h15m     0.1%  12MB    0       │
│ nginx          🔴 stopped —      —         —     —       0       │
├────────────────────────────────────────────────────────────────────┤
│ toonflow-game:  [启动] [停止] [重启] [删除]                         │
└────────────────────────────────────────────────────────────────────┘
```

添加服务弹窗字段：服务名称 / 启动命令 / 工作目录 / 保活（自动重启）/ 随 Ubuntu 启动 Nginx
