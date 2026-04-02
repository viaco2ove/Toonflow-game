# 运行项目

这份文档只负责：

- 安装 Node / pm2
- 构建并启动 `toonflow-app`
- 验证后端 `60002` 是否存活

`nginx` 和静态前端发布目录不再写在这里，单独看：

- [run.nginx.md](run.nginx.md)

## 1. 安装基础环境

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get update
apt-get install -y nodejs python3 make g++
```

## 2. 安装项目依赖

```bash
cd ~/Toonflow-game
yarn install
npm install -g pm2
```

## 3. 构建并启动后端

当前建议使用 `local` 作为这台机器的运行环境：

- `dev` 更适合快速测试和通用开发默认值
- `local` 更适合机器私有配置
- `prod` 更适合正式部署，优先吃外部环境变量

```bash
cd ~/Toonflow-game
NODE_ENV=local PREFER_PROCESS_ENV=1 npx tsx scripts/build.ts
NODE_ENV=local PREFER_PROCESS_ENV=1 pm2 start build/app.js --name toonflow-app --update-env
pm2 save
```

如果进程已经存在，改用：

```bash
pm2 restart toonflow-app --update-env
```

## 4. 检查后端是否启动成功

```bash
pm2 logs toonflow-app
curl -i http://127.0.0.1:60002/
```

说明：

- 返回 `{"message":"未提供token"}` 也算正常，说明服务已经在监听
- 如果这里 `connection refused`，就是后端进程没起来，不是接口路径写错

## 5. 安卓端怎么配

![img_2.png](../img_2.png)

安卓端 `baseUrl` 直接填：

```text
https://u904865-775058661751.bjb1.seetacloud.com:8443/
```

同时保证运行环境里的 `OSSURL` 也是同一个公网地址。
