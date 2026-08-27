# termux 根目录
/data/data/com.termux/files

# 创建文件夹
/data/data/com.termux/files/opt
/data/data/com.termux/files/data
/data/data/com.termux/files/ubuntu
/data/data/com.termux/files/var

## 修改配置

```bash
vim install.config.sh
```

至少改这个：

```bash
export PUBLIC_URL="http://你的服务器IP/"
```

# 安装主站

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
