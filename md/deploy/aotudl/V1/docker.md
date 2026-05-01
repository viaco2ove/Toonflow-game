先装 Docker 和 Compose 插件：

```  apt-get update
apt-get install -y ca-certificates curl gnupg lsb-release

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```
  装完验证：

  docker --version
  docker compose version

  然后再执行：

  cd ~/Toonflow-game
  docker compose --env-file docker/.env.autodl -f docker/docker-compose.autodl.yml up -d --build         
  

配置 AutoDL 部署环境变量

```bash
cd /root/Toonflow-game
cp docker.md/autodl.env.example docker.md/.env.autodl
```

编辑 `docker/.env.autodl`：

```env
AUTODL_HTTP_PORT=6006
AUTODL_PUBLIC_URL=http://127.0.0.1:6006/
TEMP_OSS=
```

两种常见用法：

- 走 SSH 隧道：`AUTODL_PUBLIC_URL` 保持 `http://127.0.0.1:6006/`
- 走 AutoDL 自定义服务公网地址：改成实际公网地址，例如 `https://xxx.autodl.com/`

### 6. 启动容器

```bash
cd /root/toonflow-game-app
docker.md compose --env-file docker.md/.env.autodl -f docker.md/docker.md-compose.autodl.yml up -d --build
```

首次启动会做这些事情：

- 安装 Node 依赖
- 构建后端 `build/app.js`
- 把 `scripts/web` 复制到 nginx 静态目录
- 启动 nginx
- 启动 Node/Express 后端

### 7. 查看运行状态

```bash
docker.md compose --env-file docker.md/.env.autodl -f docker.md/docker.md-compose.autodl.yml ps
docker.md logs -f toonflow-autodl
```

正常情况下：

- nginx 监听容器内 `80`
- 宿主机 `6006` 映射到容器 `80`
- 后端在容器内监听 `60002`