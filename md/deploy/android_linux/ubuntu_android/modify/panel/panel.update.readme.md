# 管理面板更新与操作指南(supervisor)


# 查看管理面板的进程 删除 pm2 里的 toonflow-panel，pm2 会导致管理面板打包失败，已弃用
  ps aux | grep -E 'uvicorn|python.*main' | grep -v grep
  
  # 重启管理面板（如果是 uvicorn 跑的），实际不是！！！
  pm2 restart 管理面板名称
  # 或
  pm2 delete 管理面板名称 && cd /opt/toonflow/panel && uvicorn main:app --host 0.0.0.0 --port 6008

  或者如果 main.py 是直接用 Python 跑的：

  # 杀掉旧进程，重启
  pkill -f "python.*main.py"? 不是这个！！！
是 systemctl stop toonflow-panel.service 
cd /opt/toonflow/panel
start-panel.sh

  重启后管理面板应该就能正常处理 POST 清空日志了。
