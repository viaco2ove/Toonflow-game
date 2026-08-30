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
sudo nginx -t

# 重新加载配置（不中断现有连接）
sudo systemctl reload nginx

# 重启 Nginx（完全重启）
sudo systemctl restart nginx
```

## 手动修改 Nginx 配置

如果需要临时修改配置（如添加代理路径），可以直接编辑：

```bash
sudo nano /etc/nginx/sites-available/toonflow-game
sudo nginx -t
sudo systemctl reload nginx
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
