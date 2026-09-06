```bash
  tower-pm2 delete toonflow-panel || true && tower-pm2 start bash --name toonflow-panel -- -lc 'cd /opt/toonflow/panel && PANEL_APP_NAME="toonflow-game" PANEL_APP_DIR="/opt/toonflow/toonflow- 
  game-app" PANEL_APP_PORT="60002" PANEL_WEB_PORT="8088" PANEL_WEB_PUBLISH_DIR="/var/www/toonflow" PANEL_WEB_PROJECT_DIR="/opt/toonflow/Toonflow-game-web"                            
  PANEL_WEB_BUILD_NODE_OPTIONS="--max-old-space-size=512" /opt/toonflow/panel/.venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 6008' && tower-pm2 save  
```

tower-pm2 restart toonflow-panel --update-env
```
cat >/opt/toonflow/panel/start-panel.sh <<'EOF'                                                                                                                                   
#!/usr/bin/env bash                                                                                                                                                               
cd /opt/toonflow/panel || exit 1                                                                                                                                                  
export PANEL_APP_NAME="toonflow-game"                                                                                                                                             
export PANEL_APP_DIR="/opt/toonflow/toonflow-game-app"                                                                                                                            
export PANEL_APP_PORT="60002"                                                                                                                                                     
export PANEL_WEB_PORT="8088"                                                                                                                                                        
export PANEL_WEB_PUBLISH_DIR="/var/www/toonflow"                                                                                                                                  
export PANEL_WEB_PROJECT_DIR="/opt/toonflow/Toonflow-game-web"                                                                                                                    
export PANEL_WEB_BUILD_NODE_OPTIONS="--max-old-space-size=512"                                                                                                                    
exec /opt/toonflow/panel/.venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 6008                                                                                          
EOF
 ```                                                                                                                                                                        
  `chmod +x /opt/toonflow/panel/start-panel.sh`  `   
 ```
tower-pm2 delete toonflow-panel || true                                                                                                                                            
tower-pm2 start /opt/toonflow/panel/start-panel.sh --name toonflow-panel
tower-pm2 save 
  ``` 
  然后马上验证：                                                                                                                                                                    
                                                                                                                                                                                    
`
tower-pm2 env toonflow-panel | grep PANEL_WEB                                                                                                                                           
tower-pm2 logs toonflow-panel --lines 20   
`