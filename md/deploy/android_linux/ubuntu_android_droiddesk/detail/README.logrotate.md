chmod +x /opt/toonflow/panel/run_logrotate.sh


```bash
#droiddesk-tower service list
droiddesk-tower service add run_logrotate /opt/toonflow/panel/run_logrotate.sh --nginx --keep-live
# droiddesk-tower service delete "ToonflneowPanel"
#droiddesk-tower service config ToonflneowPanel
```
