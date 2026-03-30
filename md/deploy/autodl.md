# AutoDL 镜像部署

## 目的

这套部署用于在 AutoDL 或其他 Linux 容器环境中运行 Toonflow 的：

- Node/Express 后端
- nginx 托管的前端静态页
- 单端口对外访问
- 持久化数据库、上传资源和本地工具目录

不包含 Electron GUI。

## 文件

- `docker/Dockerfile.autodl`
- `docker/docker-compose.autodl.yml`
- `docker/nginx.autodl.conf`
- `docker/supervisord.autodl.conf`
- `docker/autodl.env.example`

## 启动前

至少确认以下环境变量：

```env
AUTODL_HTTP_PORT=6006
AUTODL_PUBLIC_URL=http://127.0.0.1:6006/
TEMP_OSS=
```

说明：

- `AUTODL_HTTP_PORT` 建议用 AutoDL 支持的 `6006` 或 `6008`，默认用 `6006`
- `AUTODL_PUBLIC_URL` 会写入后端 `OSSURL`
- 上传图片、语音预览、章节背景、角色头像等资源链接都依赖这个地址
- 如果这里仍是 `127.0.0.1`，外部访问图片和音频会失败
- 但如果你走的是 SSH 隧道，本机浏览器访问的就是 `http://127.0.0.1:6006/`，这里保持默认即可

## 启动

```bash
cp docker/autodl.env.example docker/.env.autodl
docker compose --env-file docker/.env.autodl -f docker/docker-compose.autodl.yml up -d --build
```

## 两种访问方式

### 1. SSH 隧道

适合个人用户，或还没有 AutoDL 自定义服务公网入口时。

保持 `docker/.env.autodl` 默认值：

```env
AUTODL_HTTP_PORT=6006
AUTODL_PUBLIC_URL=http://127.0.0.1:6006/
```

容器启动后，在你本地电脑执行 AutoDL 官方 SSH 隧道命令，把实例内 `6006` 代理到本地 `6006`。

官方文档：
- <https://www.autodl.com/docs/ssh_proxy/>

这样本地浏览器访问：

```text
http://127.0.0.1:6006/
```

这时图片、音频等资源地址也会正常，因为后端生成的 `OSSURL` 与你浏览器看到的地址一致。

### 2. AutoDL 自定义服务

适合已经开通自定义服务能力的实例。

步骤：

1. 先保持 `AUTODL_HTTP_PORT=6006` 启动容器。
2. 到 AutoDL 控制台查看该实例的“自定义服务”分配地址。
3. 把 `docker/.env.autodl` 里的 `AUTODL_PUBLIC_URL` 改成这个公网地址。
4. 重新启动容器。

示例：

```env
AUTODL_HTTP_PORT=6006
AUTODL_PUBLIC_URL=https://你的-autodl-公网地址/
```

说明：

- AutoDL 的公网访问地址通常是在实例启动、服务暴露之后，去控制台查看“自定义服务”时拿到
- 不是部署前就固定写死的
- 如果你还没拿到这个地址，就先用 SSH 隧道方案

官方文档：
- <https://www.autodl.com/docs/port/>
- <https://www.autodl.com/docs/service_agreement/>

## 数据目录

compose 默认把数据挂到：

```text
../data/autodl -> /data/toonflow
```

其中包括：

- `db.sqlite`
- `uploads/`
- `tools/`
- `logs/`

## 说明

- 这套镜像默认启用 `PREFER_PROCESS_ENV=1`，优先使用容器注入环境变量，而不是仓库里的 `env/.env.prod`
- 镜像会复制 `res/voice-presets`，保证内置语音种子在容器里可用
- 镜像安装了 `python3/python3-venv/python3-pip/ffmpeg`，便于运行本地 BiRefNet 和 GIF 转换链路
- 当前本地 BiRefNet 仍是 CPU 版 `onnxruntime`，不会自动使用 AutoDL GPU
