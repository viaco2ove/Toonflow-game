#!/bin/bash
INTERVAL=360  #  例如3600 代表每隔 1 小时()执行一次（秒） 时间为：INTERVAL/3600 单位时，360  =0.1 h

while true; do
    logrotate -f /etc/logrotate.d/nginx
    sleep $INTERVAL
done