# sqlite-web（浏览器可视化操作）
在安卓 Ubuntu 上启动一个 Web 管理界面，Windows 用浏览器访问。
安卓 Ubuntu 端：
# 安装 python3 和 pip
sudo apt install python3 python3-pip -y

conda activate base
# 安装 sqlite-web
pip3 install sqlite-web

# 启动 Web 服务，监听所有网卡，端口 8122
**need:conda activate base**
sqlite_web /data/toonflow/db.sqlite --host 0.0.0.0 --port 8222