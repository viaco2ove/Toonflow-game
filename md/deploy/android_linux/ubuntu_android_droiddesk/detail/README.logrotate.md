# 授权
chmod +x /opt/toonflow/panel/run_logrotate.sh

# 安装 logrotate
apt update && apt install logrotate -y

# 写入配置
```bash
cat > /etc/logrotate.d/nginx << 'EOF'
/var/log/nginx/*.log {
    daily
    missingok
    rotate 3
    size 50M
    compress
    delaycompress
    notifempty
    create 0640 www-data adm
    sharedscripts
    postrotate
        if [ -f /run/nginx.pid ]; then
            kill -USR1 $(cat /run/nginx.pid)
        fi
    endscript
}
EOF
```

# 增加服务
```bash
#droiddesk-tower service list
droiddesk-tower service add run_logrotate /opt/toonflow/panel/run_logrotate.sh --nginx --keep-live
# droiddesk-tower service delete "ToonflneowPanel"
#droiddesk-tower service config ToonflneowPanel
```


# /etc/nginx/nginx.conf
参考配置。
worker_processes 改为3，error_log 改为 emerg，缺点很大错误看不见，好处就是错误日志减少许多 。 特别是proot
use poll，取代 默认的 epoll
```bash
user www-data;
# worker_processes auto;
worker_processes 3;
# worker_cpu_affinity auto;
pid /run/nginx.pid;
error_log /var/log/nginx/error.log emerg;
events {
    use poll;
    worker_connections 768;
    # multi_accept on;
}
```