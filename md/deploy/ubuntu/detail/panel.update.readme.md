```
cp ~/ubuntu/detail/main.py /opt/toonflow/panel/main.py
systemctl restart toonflow-panel.service                                                                                                                                          
systemctl status toonflow-panel.service --no-pager
```

查看服务状态：

```bash
systemctl status toonflow-panel.service --no-pager
```

查看最近日志：

```bash
journalctl -u toonflow-panel.service -n 100 --no-pager
```