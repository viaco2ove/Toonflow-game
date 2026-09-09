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
    rotate 7
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
