#!/bin/bash
INTERVAL=3600  # 每隔 1 小时执行一次（秒）

while true; do
    logrotate -f /etc/logrotate.d/nginx
    sleep $INTERVAL
done