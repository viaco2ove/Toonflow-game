# Nginx 配置路径与维护方案

## Nginx 配置文件路径

```
/etc/nginx/sites-available/toonflow-game    # 主配置（源文件由 install.sh 生成）
/etc/nginx/sites-enabled/toonflow-game      # 软链接（启用状态）
```

## 配置文件生成方式

Nginx 配置由 `install.sh` 中的 `write_nginx_config()` 函数生成，路径为：

```bash
# 查看当前生效的 Nginx 配置
cat /etc/nginx/sites-available/toonflow-game

# 测试配置语法
nginx -t

droiddesk-tower nginx status/start/stop/restart/reload
```

## 手动修改 Nginx 配置

如果需要临时修改配置（如添加代理路径），可以直接编辑：

```bash
nano /etc/nginx/sites-available/toonflow-game
nginx -t
droiddesk-tower nginx reload
```

## 重新生成 Nginx 配置

如果需要让 `install.sh` 重新生成配置，需要重新运行部署脚本，或手动调用配置生成函数。

## 重要：代理路径

Nginx 会将以下路径的请求代理到 FastAPI 后端 (`127.0.0.1:60002`)：

| 路径 | 说明 |
|------|------|
| `/game/` | 游戏接口 |
| `/assets/` | 资源接口 |
| `/voice/` | 语音接口 |
| `/setting/` | 设置接口 |
| `/other/` | 其他接口 |
| `/user/` | 用户接口 |
| `/project/` | 项目接口 |
| `/prompt/` | 提示词接口 |
| `/index/` | 索引接口 |
| `/novel/` | 小说接口 |
| `/outline/` | 大纲接口 |
| `/script/` | 脚本接口 |
| `/storyboard/` | 分镜接口 |
| `/task/` | 任务接口 |
| `/video/` | 视频接口 |
| `/app/` | 部署管理面板接口 |

**注意**：如果新增了 FastAPI 后端的 API 路径，必须同步更新 `install.sh` 中的 Nginx 配置代理路径列表，否则该路径会返回 404 或 405。

## 静态文件路径

```
/var/www/toonflow    # Web 前端静态文件发布目录
```

Web 构建后的文件会 rsync 到此目录，由 Nginx 直接提供静态服务。


## 监控
```
#看看有没有跑了多个线程
ps aux | grep "nginx" | grep -v grep


# 只查 master 进程
ps aux | grep 'nginx: master' | grep -v grep

# 僵尸进程的状态字段（STAT 列）以 Z 开头：
ps aux | grep nginx | awk '$8 ~ /^Z/'

# 查正常 worker 进程
worker 进程的状态是 S（睡眠）或 R（运行），不是 Z：
ps aux | grep 'nginx: worker' | grep -v grep
```

```
# 强制杀死 nginx 进程
pkill -9 nginx
```

# 查看谁占了 8088(nginx 端口)
```
# 可能没有 -tlnp
# ss -tlnp | grep 8088
# grep -r "8088" /proc/*/net/tcp6 2>/dev/null
# 安装net-tools
# apt install net-tools -y
netstat -tlnp | grep 8088
```