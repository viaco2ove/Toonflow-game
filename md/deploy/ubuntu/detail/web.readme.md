# Web 项目维护手册

## 目录

- [常规构建与部署](#常规构建与部署)
- [前端强制重新拉取](#前端强制重新拉取)
- [后端强制重新拉取](#后端强制重新拉取)
- [强制对齐远端分支](#强制对齐远端分支)

---

## 常规构建与部署

### 1. 构建前端

```bash
cd /opt/toonflow/Toonflow-game-web
rm -rf node_modules
yarn cache clean
yarn install --frozen-lockfile --force
export NODE_OPTIONS=--max-old-space-size=512
yarn build
```

### 2. 同步到后端和 Nginx

```bash
# 同步到后端 scripts/web 目录
rm -rf /opt/toonflow/toonflow-game-app/scripts/web
mkdir -p /opt/toonflow/toonflow-game-app/scripts/web
rsync -a --delete dist/ /opt/toonflow/toonflow-game-app/scripts/web/

# 同步到 Nginx 发布目录
rsync -a --delete dist/ /var/www/toonflow/
chown -R www-data:www-data /var/www/toonflow
chmod -R 755 /var/www/toonflow

# 重新加载 Nginx
nginx -t && systemctl reload nginx
```

---

## 前端强制重新拉取

完全删除并重新克隆前端仓库：

```bash
rm -rf /opt/toonflow/Toonflow-game-web
git clone -b dev https://github.com/viaco2ove/Toonflow-game-web.git /opt/toonflow/Toonflow-game-web
cd /opt/toonflow/Toonflow-game-web

# 验证克隆结果
git branch --show-current
ls src/main.ts
```

---

## 后端强制重新拉取

完全删除并重新克隆后端仓库：

```bash
rm -rf /opt/toonflow/toonflow-game-app
git clone -b dev https://github.com/viaco2ove/Toonflow-game.git /opt/toonflow/toonflow-game-app
cd /opt/toonflow/toonflow-game-app

# 验证克隆结果
git branch --show-current
```

---

## 强制对齐远端分支

如果不想直接删除仓库，可以使用 `git reset --hard` 强制对齐远端：

```bash
cd /opt/toonflow/toonflow-game-app
git fetch origin
git checkout dev
git reset --hard origin/dev
git clean -fd
```

> **注意**：`git reset --hard` 会丢弃所有本地未提交的修改，请谨慎使用！

  前端重拉后直接构建发布                                                                                                                                                            
                                                                                                                                                                                    
```bash
cd /opt/toonflow/Toonflow-game-web                                                                                                                                                
  rm -rf node_modules                                                                                                                                                               
  yarn cache clean                                                                                                                                                                  
  yarn install --frozen-lockfile --force                                                                                                                                            
  export NODE_OPTIONS=--max-old-space-size=512                                                                                                                                      
  yarn build                                                                                                                                                                        
  rsync -a --delete dist/ /opt/toonflow/toonflow-game-app/scripts/web/                                                                                                              
  rsync -a --delete dist/ /var/www/toonflow/                                                                                                                                        
  chown -R www-data:www-data /var/www/toonflow                                                                                                                                      
  chmod -R 755 /var/www/toonflow                                                                                                                                                    
  nginx -t && systemctl reload nginx
```