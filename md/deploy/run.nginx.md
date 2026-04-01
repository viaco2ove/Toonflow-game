# nginx???
4. 配 nginx 

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