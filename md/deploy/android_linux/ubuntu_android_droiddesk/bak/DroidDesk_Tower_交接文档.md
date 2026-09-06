# DroidDesk Tower 交接文档（SESSION HANDOFF）

> 创建：2026-09-06 03:35 GMT+8
> 原因：切换工作空间前的完整上下文导出
> 状态：**P0 nginx 修复已完成 ✅，tower-pm2 代码已完成 ⬜，待编译 APK + 真机验证 ⬜**

---

## 一、一句话背景

Android 设备（PLU110，192.168.31.66）上的 DroidDesk Ubuntu 环境，四个操作入口
（ubuntu shell 按钮 / SSH 8122 / PC 浏览器 7088 / 其他）的 `tower-pm2 status` 结果不一致。
实测根因：**proot 下 unix domain socket 只在创建它的 proot 实例内可见**。
决策：**放弃 tower-pm2 / supervisor，自建 DroidDesk Tower**（类宝塔 Web 运维面板，TCP + pid 文件 + /proc）。
**最终方案：tower-pm2（自研单实例 Python 守护进程），端口 7088，一服务一 PID，keep_live 自动重启（防抖 5 分钟 5 次）。**

---

## 二、关键设备信息

| 项 | 值 |
|---|---|
| 设备 | PLU110（Android），局域网 192.168.31.66 |
| SSH | root / 31495126，端口 **8122**（用 paramiko 5.0.0 连接） |
| adb | USB 设备 ID `3B65CS012RH00000` |
| DroidDesk 包名 | `com.orailnoor.droiddesk` |
| rootfs | `/data/data/com.orailnoor.droiddesk/files/usr/var/lib/proot-distro/containers/ubuntu/rootfs` |
| Python | 3.14.4（/usr/bin/python3），无 fastapi/uvicorn（系统级） |
| venv | `/opt/toonflow/panel/.venv/bin/uvicorn` ✅ 已有 uvicorn（Tower 复用它） |
| 业务 | `/opt/toonflow/toonflow-game-app`（node，60002 端口） |
| 面板 | `/opt/toonflow/panel/main.py`（6008 端口，依赖 tower-pm2） |
| 磁盘 | 修复后 219G/135G/85G（62%） |

### Windows 本地路径

| 用途 | 路径 |
|---|---|
| DroidDesk 源码 | `D:\Users\viaco\PycharmProjects\TermuxPilot\android\DroidDesk` |
| 部署文档 | `D:\Users\viaco\tools\Toonflow-game\toonflow-game-app\md\deploy\android_linux\ubuntu_android_droiddesk\` |
| 设计方案 | 同上目录 `DroidDesk_Tower_设计方案.md` |
| 本文档 | 同上目录 `DroidDesk_Tower_交接文档.md` |

---

## 三、核心结论（全部真机实测，非推测）

### 3.1 proot 跨实例通道能力表（★ 方案地基）

| 通道 | 跨 proot 实例 | Tower 用途 |
|---|---|---|
| unix domain socket | ❌ **不可见** | tower-pm2/supervisor 死因，禁用 |
| TCP（127.0.0.1/LAN） | ✅ 通 | **Tower 唯一通信方式** |
| `/proc/<pid>` | ✅ 可见 | 存活判定唯一真相源 |
| 普通文件（pid/日志/配置） | ✅ 共享 | 状态持久化 |

补充：Python `statx` 在 proot 下对 AF_UNIX 返回 `EINVAL(22)` → supervisorctl 双重不可用。
bash `[ -S ]` / node net.connect 正常。

### 3.2 tower-pm2 分裂机制

`ubuntu-shell.cmd`（MainActivity.kt:334-359 生成）含 `nohup tower-pm2 resurrect &` 兜底，
App shell 实例看不到 rpc.sock → 自 spawn 空 daemon → 列表分裂。

### 3.3 nginx epoll 报错（本次新发现）

- `epoll_wait() failed (38: ENOSYS)`：proot 缺 epoll_pwait2 syscall
- **error.log 暴涨到 15GB**（磁盘 68%），因容器无 cron/logrotate/systemd timer
- **已修复 ✅**（见第四节）

---

## 四、本次已完成 ✅

### 4.1 释放 15GB 日志

```bash
tail -1000 /var/log/nginx/error.log > /root/nginx-error.tail.log  # 备份尾部
: > /var/log/nginx/error.log                                       # truncate（非 rm）
kill -USR1 $(cat /run/nginx.pid)                                   # 重开句柄
```
结果：15G → 0，磁盘 68% → **62%**

### 4.2 压制 error.log 级别

```bash
sed -i 's|^error_log /var/log/nginx/error.log|error_log /var/log/nginx/error.log crit|' /etc/nginx/nginx.conf
nginx -t && nginx -s reload
```
结果：✅ reload 成功。即使 epoll alert 复发也不会刷爆磁盘。

### 4.3 尝试过但失败的方案（重要教训）

| 尝试 | 结果 | 原因 |
|---|---|---|
| `use poll;` | ❌ `invalid event type "poll"` | 该 nginx 编译时**未编译 poll 模块** |
| `use select;` | ❌ `invalid event type "select"` | 同上，select 模块也没有 |
| `nginx -V` 检查 | 只有 `--with-http_*_module`，**无 event 模块可选** | Ubuntu 的 nginx 包通常只带 epoll，无 fallback |
| **最终方案** | `error_log ... crit;` 压日志 | **无法绕开 epoll**，只能压日志+依赖看门狗重建 |

> ⚠️ 若 epoll alert 再次刷屏，唯一手段是：truncate 日志（Tower 巡检内置了这能力，见 6.3）

---

## 五、Tower 设计要点（下一步实现的依据）

### 5.1 架构

```
DroidDesk App（前台服务保活）
└─ 唯一常驻 proot Ubuntu 容器
     ├─ tower-pm2 :7088      单实例 Python 守护进程，HTTP API + 内嵌宝塔风 Web UI
     ├─ sshd :8122
     ├─ nginx :8088
     └─ 业务进程（python3 -m panel --port 60002 …）
     全部由 Tower 用「setsid + pid 文件 + /proc 校验」管理
```

### 5.2 服务注册表 `/etc/tower/services.json`（array 格式）

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
    }
  ]
}
```

### 5.3 API 设计

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 宝塔风 Web UI |
| GET | `/api/list` | 全部状态（pid/alive/cpu/mem/uptime/重启次数） |
| GET | `/api/system` | CPU 核数/内存/磁盘/负载/系统运行时长 |
| POST | `/api/start/<name>` | 启动 |
| POST | `/api/stop/<name>` | 停止 |
| POST | `/api/restart/<name>` | 重启 |
| POST | `/api/delete/<name>` | 删除服务（先停再删配置） |
| POST | `/api/add` | 添加服务（body: JSON） |
| POST | `/api/refresh` | 刷新所有服务状态 |

### 5.4 内置巡检（容器无 cron，Tower 即 cron）

| 能力 | 实现 | 触发 |
|---|---|---|
| 日志看护 | 单文件 >100MB truncate（留尾部 2000 行） | 60s |
| keep_live | 进程死后自动重启（防抖：5 分钟内 >5 次则 crash_loop） | 5s |
| 磁盘水位 | >85% 面板告警 | 5min |
| 孤儿回收 | pid 文件与 /proc 比对，清理残留 | 5s |

### 5.5 实现环境

- **Python 3.14** + psutil（仅额外依赖）
- 纯标准库：`http.server.HTTPServer`、`subprocess`、`signal`、`threading`、`json`
- 无 fastapi/uvicorn/requests —— 不引入额外依赖

---

## 六、落地路线图

| 阶段 | 动作 | 状态 |
|---|---|---|
| P0 | nginx 日志释放 + crit 级别 | ✅ **已完成** |
| P1 | tower-pm2 代码编写（DroidDesk assets + external deploy） | ✅ **已完成** |
| P2 | 编译 DroidDesk APK（`flutter build apk --debug`） | ⬜ **下一步** |
| P3 | 真机装 APK → `DroidDeskPlatform.installTower()` | ⬜ |
| P4 | PC 浏览器打开 `http://192.168.31.66:7088` 验 Web UI | ⬜ |
| P5 | 验 start/stop/restart/add/delete/crash_loop 防抖 | ⬜ |
| P6 | 四入口一致性验证（App WebView/PC 浏览器/SSH curl/ubuntu shell 按钮） | ⬜ |

### P2 具体任务（从这继续）

1. 在有 Flutter SDK 的机器上：`cd DroidDesk/app && flutter build apk --debug`
2. 真机安装：`adb install -r build/app/outputs/flutter-apk/app-debug.apk`
3. 打开 DroidDesk → Ubuntu Console → 调用 `DroidDeskPlatform.installTower()`
4. PC 浏览器：`http://192.168.31.66:7088`
5. 验证 API：`curl -X POST http://127.0.0.1:7088/api/start/toonflow-game`
6. **关键验证点**：在 App shell 内（adb run-as 起 proot 实例）curl 127.0.0.1:7088 必须返回同一份状态 ← 整个方案成败判定

---

## 七、关键教训（避免重蹈）

1. **不要在 SSH 会话内模拟 App shell** —— 必须用 `adb shell run-as com.orailnoor.droiddesk`（宿主侧）起等价容器
2. **不要跑 `tower-pm2 status`** —— 一次就会打崩 daemon（30s 后看门狗自动恢复，但业务中断）
3. **f-string 嵌 shell 命令易炸** —— 用 base64 注入脚本内容
4. **nginx 的 `use` 指令受编译选项限制** —— Ubuntu 包默认只有 epoll
5. **一切下结论前实测** —— 本次三次纠正自己的错误判断，最终用户是对的

---

## 八、文件与工具清单

| 文件 | 说明 |
|---|---|
| `DroidDesk_Tower_设计方案.md` | 完整设计（9 章） |
| `DroidDesk_Tower_交接文档.md` | 本文档 |
| `.workbuddy/memory/2026-09-06.md` | 调研与纠错全过程（原工作空间） |
| paramiko 5.0.0 | Windows 侧 SSH 工具（managed python 3.13.12） |

### 临时脚本（均已删除 ✅）

`.tmp_ssh_probe.py` / `.tmp_probe2.py` / `.tmp_cross.py` / `.tmp_clean.py` /
`.tmp_appleshell.sh` / `.tmp_nginx.py` / `.tmp_nginx_fix.py` / `.tmp_nginx_fix2.py` /
`.tmp_probe_env.py` / `.tmp_nginx_fix3.py`（需清理）
