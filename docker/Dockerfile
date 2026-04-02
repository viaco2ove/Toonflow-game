# 构建阶段
FROM node:24-alpine AS builder

WORKDIR /app

# 定义构建参数
ARG GIT=github
ARG TAG=""
ARG BRANCH=""

# 安装 git
RUN apk add --no-cache git

RUN npm config set registry https://registry.npmmirror.com/ && \
    yarn config set registry https://registry.npmmirror.com/

# 根据参数选择仓库源，支持 TAG / BRANCH 切换
# 优先级: TAG > BRANCH > 最新 tag > 默认分支
RUN if [ "$GIT" = "gitee" ]; then \
        REPO_URL="https://gitee.com/HBAI-Ltd/Toonflow-app.git"; \
    else \
        REPO_URL="https://github.com/HBAI-Ltd/Toonflow-app.git"; \
    fi && \
    echo "Cloning from: $REPO_URL" && \
    git clone "$REPO_URL" . && \
    if [ -n "$TAG" ]; then \
        echo "Checking out specified tag: $TAG" && \
        git checkout "$TAG"; \
    elif [ -n "$BRANCH" ]; then \
        echo "Checking out specified branch: $BRANCH" && \
        git checkout "$BRANCH"; \
    else \
        LATEST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || git tag --sort=-v:refname | head -n 1) && \
        if [ -n "$LATEST_TAG" ]; then \
            echo "Checking out latest tag: $LATEST_TAG" && \
            git checkout "$LATEST_TAG"; \
        else \
            echo "No tags found, using default branch"; \
        fi; \
    fi && \
    echo "Current version:" && git describe --tags --always

RUN yarn install --frozen-lockfile

RUN yarn build

# 生产阶段
FROM node:24-alpine

WORKDIR /app

# 安装 nginx 和 supervisor
RUN apk add --no-cache nginx supervisor && \
    mkdir -p /var/lib/nginx/logs /var/log/nginx && \
    npm config set registry https://registry.npmmirror.com/ && \
    yarn config set registry https://registry.npmmirror.com/ && \
    npm install -g pm2

# 复制后端文件
COPY --from=builder /app/build ./build
COPY --from=builder /app/package.json ./
COPY --from=builder /app/yarn.lock ./

# 复制静态页面到 nginx 目录
COPY --from=builder /app/scripts/web /usr/share/nginx/html

# 只安装生产依赖
RUN yarn install --frozen-lockfile --production

# 配置 nginx
RUN cat > /etc/nginx/http.d/default.conf << 'EOF'
server {
    listen 80;
    location / {
        root /usr/share/nginx/html;
        index index.html;
        try_files $uri $uri/ /index.html;
    }
}
EOF

# 配置 nginx 主配置，日志输出到 stderr/stdout
RUN sed -i 's|error_log /var/log/nginx/error.log warn;|error_log /dev/stderr warn;|g' /etc/nginx/toonflow || true && \
    sed -i 's|access_log /var/log/nginx/access.log main;|access_log /dev/stdout main;|g' /etc/nginx/toonflow || true

# 配置 supervisor
RUN cat > /etc/supervisord.conf << 'EOF'
[supervisord]
nodaemon=true
logfile=/var/log/supervisord.log
pidfile=/var/run/supervisord.pid

[program:nginx]
command=nginx -g "daemon off;"
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0

[program:app]
command=pm2-runtime start build/app.js --name app
directory=/app
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
environment=NODE_ENV=prod
EOF

ENV NODE_ENV=prod

EXPOSE 80
EXPOSE 60002

# 启动时创建必要目录（防止 volume 挂载覆盖）
CMD sh -c "mkdir -p /var/log/nginx /var/lib/nginx/logs && exec supervisord -c /etc/supervisord.conf"
