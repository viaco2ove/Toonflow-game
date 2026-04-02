# nginx 运行与发布目录

当前推荐方案只有一套：

- `nginx` 监听 `6006`
- 反向代理后端到 `127.0.0.1:60002`
- 静态前端统一发布到 `/var/www/toonflow`

不要再让 `nginx` 直接读 `/root/Toonflow-game/scripts/web`，否则很容易再次踩到 `/root` 权限问题。

## 1. 安装 nginx

```bash
apt-get update
apt-get install -y nginx
service nginx status
```

## 2. 写入配置

把下面这个文件保存成：

`/etc/nginx/sites-available/toonflow`

[toonflow](nginx_config/toonflow)

启用配置：

```bash
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/toonflow /etc/nginx/sites-enabled/toonflow
nginx -t
service nginx restart
```

## 3. 发布静态前端到真正线上目录

说明：

- 开发源目录：`/root/Toonflow-game/scripts/web`
- 真正线上目录：`/var/www/toonflow`
- 页面没变化时，优先检查是不是忘了同步到 `/var/www/toonflow`

同步命令：

```bash
mkdir -p /var/www/toonflow
rsync -a --delete /root/Toonflow-game/scripts/web/ /var/www/toonflow/
chown -R www-data:www-data /var/www/toonflow
chmod -R 755 /var/www/toonflow
nginx -t && service nginx reload
```

## 4. 检查 nginx

```bash
curl -I http://127.0.0.1:6006/
tail -n 100 /var/log/nginx/error.log
tail -n 100 /var/log/nginx/access.log
```

如果页面显示还是旧的，优先检查：

```bash
head -n 5 /var/www/toonflow/index.html
```

而不是先怀疑缓存。
