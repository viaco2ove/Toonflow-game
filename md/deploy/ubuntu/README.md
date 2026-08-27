# Ubuntu 安装
配置和维护详情:
[README.md](detail/README.md)

## ubuntu 环境设置
[README.md](modify/init/README.md)

下面内容只涉及安装
## 1. 传目录到服务器
[main.py](detail/main.py)
[install.config.sh](install.config.sh)
[install.sh](install.sh)
```bash
scp -r md/deploy/android_linux root@你的服务器IP:/data/data/com.termux/files/ubuntu
```

## 2. 登录服务器

```bash
ssh root@你的服务器IP
cd ~/ubuntu
```

## 3. 修改配置

```bash
vim install.config.sh
```

至少改这个：

```bash
export PUBLIC_URL="http://你的服务器IP/"
```

## 4. 安装主站

```bash
chmod +x install.sh
source ./install.config.sh
./install.sh
```

这一步会一起安装：
- 主站
- nginx
- pm2
- `detail/main.py` 管理页

打开主站：

```text
http://你的服务器IP/
```

打开管理页：

```text
http://你的服务器IP:6008/
```

注意：

```text
这里是 :6008
不是 /6008/
```
