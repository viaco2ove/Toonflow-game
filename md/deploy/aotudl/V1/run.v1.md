cd ~/Toonflow-game
yarn
mkdir -p env
cat > env/.env.local <<'EOF' 
NODE_ENV=local 
PORT=60002
OSSURL=http://127.0.0.1:6006/ 
DB_PATH=/root/toonflow-data/db.sqlite 
UPLOAD_DIR=/root/toonflow-data/uploads
LOCAL_TOOL_DIR=/root/toonflow-data/tools
LOG_PATH=/root/toonflow-data/logs 
PREFER_PROCESS_ENV=1
TEMP_OSS= 
EOF

mkdir -p /root/toonflow-data/uploads /root/toonflow-data/tools /root/toonflow-data/logs 
NODE_ENV=local PREFER_PROCESS_ENV=1 yarn build 
pm2 start build/app.js --name toonflow-app --update-env 
pm2 save
