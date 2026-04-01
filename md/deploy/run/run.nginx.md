# nginx???
sudo apt update
sudo apt install nginx
sudo systemctl status nginx

# 使用 service 命令（最常用）
bash
运行
## 启动 Nginx
sudo service nginx start

## 停止 Nginx
sudo service nginx stop

## 重启 Nginx
sudo service nginx restart

## 查看状态
sudo service nginx status

# 配置防火墙（可选但推荐）
## 查看可用的应用配置
sudo ufw app list

## 允许 HTTP 和 HTTPS 流量
sudo ufw allow 'Nginx Full'

## 检查防火墙状态
sudo ufw status

# 配 nginx 

cat > /etc/nginx/sites-available/toonflow <<'EOF' 
server {
listen 6006;
server_name _;

root /root/Toonflow-game/scripts/web; 
index index.html; 

client_max_body_size 200m;

location ~ ^/(assets|game|index|novel|other|outline|project|prompt|script|setting|storyboard|task|user|video|voice|system|[0-9]+)(/|$) {
proxy_pass http://127.0.0.1:60002;
proxy_http_version 1.1; 
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme; 
proxy_read_timeout 3600s; 
proxy_send_timeout 3600s; 
proxy_buffering off;
} 

location / {
try_files $uri $uri/ /index.html; 
} 
} 
EOF 

rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/toonflow /etc/nginx/sites-enabled/toonflow
nginx -t
service nginx restart


# 看 nginx 日志最快。
                                                                                                                                                                                                                                    
  Ubuntu 上通常在这两个文件：                                                                                                                                                                                                       
                                                                                                                                                                                                                                    
  tail -n 100 /var/log/nginx/error.log                                                                                                                                                                                              
  tail -n 100 /var/log/nginx/access.log   