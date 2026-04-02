from fastapi import FastAPI
from fastapi.responses import HTMLResponse, RedirectResponse, PlainTextResponse
import subprocess

app = FastAPI()


def run(cmd: str) -> str:
    p = subprocess.run(cmd, shell=True, text=True, capture_output=True)
    return (p.stdout or "") + (p.stderr or "")


def service_status():
    pm2_list = run("pm2 jlist")
    nginx_status = run("service nginx status || systemctl status nginx --no-pager || true")
    app_health = run("curl -sS --max-time 3 http://127.0.0.1:60002/ || true")
    web_health = run("curl -I -sS --max-time 3 http://127.0.0.1:6006/ || true")
    return pm2_list, nginx_status, app_health, web_health


@app.get("/", response_class=HTMLResponse)
def home():
    pm2_list, nginx_status, app_health, web_health = service_status()
    return f"""
    <html>
    <head>
      <meta charset="utf-8">
      <title>Toonflow 管理页</title>
      <style>
        body {{ font-family: Arial, sans-serif; max-width: 1100px; margin: 30px auto; }}
        h1, h2 {{ margin-bottom: 8px; }}
        .btns a {{
          display: inline-block; padding: 10px 14px; margin: 6px 8px 6px 0;
          text-decoration: none; border: 1px solid #ccc; border-radius: 8px; color: #111;
        }}
        pre {{
          background: #111; color: #0f0; padding: 12px; overflow: auto; white-space: pre-wrap;
          border-radius: 8px;
        }}
      </style>
    </head>
    <body>
      <h1>Toonflow 健康管理</h1>

      <div class="btns">
        <a href="/start_all">启动全部</a>
        <a href="/restart_all">重启全部</a>
        <a href="/stop_all">停止全部</a>
      </div>

      <div class="btns">
        <a href="/start_app">启动 toonflow-app</a>
        <a href="/restart_app">重启 toonflow-app</a>
        <a href="/stop_app">停止 toonflow-app</a>
      </div>

      <div class="btns">
        <a href="/start_nginx">启动 nginx</a>
        <a href="/restart_nginx">重启 nginx</a>
        <a href="/stop_nginx">停止 nginx</a>
      </div>

      <div class="btns">
        <a href="/logs_app">查看 app 日志</a>
        <a href="/logs_nginx">查看 nginx error.log</a>
        <a href="/">刷新状态</a>
        <a href="http://127.0.0.1:6006/" target="_blank">本机测试 6006</a>
      </div>

      <h2>pm2 状态</h2>
      <pre>{pm2_list}</pre>

      <h2>nginx 状态</h2>
      <pre>{nginx_status}</pre>

      <h2>app 健康检查: 127.0.0.1:60002</h2>
      <pre>{app_health}</pre>

      <h2>web 健康检查: 127.0.0.1:6006</h2>
      <pre>{web_health}</pre>
    </body>
    </html>
    """


@app.get("/start_app")
def start_app():
    run("pm2 start toonflow-app || pm2 restart toonflow-app || true")
    return RedirectResponse("/", status_code=302)


@app.get("/restart_app")
def restart_app():
    run("pm2 restart toonflow-app || true")
    return RedirectResponse("/", status_code=302)


@app.get("/stop_app")
def stop_app():
    run("pm2 stop toonflow-app || true")
    return RedirectResponse("/", status_code=302)


@app.get("/start_nginx")
def start_nginx():
    run("service nginx start || true")
    return RedirectResponse("/", status_code=302)


@app.get("/restart_nginx")
def restart_nginx():
    run("service nginx restart || true")
    return RedirectResponse("/", status_code=302)


@app.get("/stop_nginx")
def stop_nginx():
    run("service nginx stop || true")
    return RedirectResponse("/", status_code=302)


@app.get("/start_all")
def start_all():
    run("service nginx start || true")
    run("pm2 start toonflow-app || pm2 restart toonflow-app || true")
    return RedirectResponse("/", status_code=302)


@app.get("/restart_all")
def restart_all():
    run("pm2 restart toonflow-app || true")
    run("service nginx restart || true")
    return RedirectResponse("/", status_code=302)


@app.get("/stop_all")
def stop_all():
    run("pm2 stop toonflow-app || true")
    run("service nginx stop || true")
    return RedirectResponse("/", status_code=302)


@app.get("/logs_app", response_class=PlainTextResponse)
def logs_app():
    return run("pm2 logs toonflow-app --lines 100 --nostream || true")


@app.get("/logs_nginx", response_class=PlainTextResponse)
def logs_nginx():
    return run("tail -n 100 /var/log/nginx/error.log || true")
