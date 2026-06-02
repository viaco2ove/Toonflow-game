```
cp ~/ubuntu/detail/main.py /opt/toonflow/panel/main.py
systemctl restart toonflow-panel.service                                                                                                                                          
systemctl status toonflow-panel.service --no-pager

systemctl stop toonflow-panel.service 
```

查看服务状态：

```bash
systemctl status toonflow-panel.service --no-pager
```

查看最近日志：

```bash
journalctl -u toonflow-panel.service -n 100 --no-pager
```


# 查看管理面板的进程
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
