from fastapi import FastAPI
from fastapi.responses import HTMLResponse, RedirectResponse, PlainTextResponse
import html
import subprocess

app = FastAPI()

APP_NAME = "toonflow-app"
APP_DIR = "/root/Toonflow-game"
APP_PORT = 60002
WEB_PORT = 6006
START_APP_CMD = (
    f"cd {APP_DIR} && "
    "NODE_ENV=local PREFER_PROCESS_ENV=1 "
    f"pm2 start build/app.js --name {APP_NAME} --update-env"
)


def run(cmd: str) -> str:
    p = subprocess.run(cmd, shell=True, text=True, capture_output=True)
    return (p.stdout or "") + (p.stderr or "")


def shell_text(text: str) -> str:
    return html.escape(text or "").replace("\n", "<br>")


def detect_pm2_status(pm2_text: str) -> str:
    if APP_NAME not in pm2_text:
        return "missing"
    if "online" in pm2_text:
        return "online"
    if "stopped" in pm2_text:
        return "stopped"
    if "errored" in pm2_text:
        return "errored"
    return "unknown"


def detect_nginx_running(nginx_text: str) -> bool:
    lowered = nginx_text.lower()
    return (
        "active (running)" in lowered
        or "nginx is running" in lowered
        or lowered.strip() == "active"
    )


def detect_listening(port_text: str, port: int) -> bool:
    return "listen" in port_text.lower() and f":{port}" in port_text


def detect_http_ok(http_text: str) -> bool:
    return http_text.startswith("HTTP/")


def summarize_app_hint(status: dict) -> str:
    if status["app_listening"] and status["app_http_ok"]:
      return f"app 正在本机 {APP_PORT} 端口提供 HTTP 服务。"
    if status["pm2_state"] == "online" and not status["app_listening"]:
      return "pm2 显示进程在线，但本机没有检测到 60002 监听。这通常表示进程起了但绑定了别的端口，或者管理页与业务进程不在同一网络命名空间。"
    if status["web_http_ok"] and not status["app_listening"]:
      return "web 入口是正常的，但本机 60002 没监听。说明当前业务页很可能不是直接由这台主机上的 127.0.0.1:60002 提供，而是走了其他端口、容器网络或上游服务。"
    return "当前没有检测到 app 本机监听。若业务页却能正常打开，请重点核对真实后端端口、pm2 启动脚本和 nginx 实际 upstream。"


def badge(label: str, kind: str) -> str:
    return f'<span class="badge badge-{kind}">{html.escape(label)}</span>'


def status_card(title: str, summary: str, status_label: str, kind: str) -> str:
    return f"""
    <div class="status-card">
      <div class="status-top">
        <div class="status-title">{html.escape(title)}</div>
        {badge(status_label, kind)}
      </div>
      <div class="status-summary">{html.escape(summary)}</div>
    </div>
    """


def service_status():
    pm2_list = run("pm2 jlist")
    nginx_status = run("service nginx status 2>&1 || systemctl status nginx --no-pager 2>&1 || true")
    app_port = run(f"ss -lntp | grep ':{APP_PORT} ' || true")
    app_http = run(f"curl -i -sS --max-time 3 http://127.0.0.1:{APP_PORT}/ || true")
    web_port = run(f"ss -lntp | grep ':{WEB_PORT} ' || true")
    web_http = run(f"curl -I -sS --max-time 3 http://127.0.0.1:{WEB_PORT}/ || true")
    return {
        "pm2_list": pm2_list,
        "nginx_status": nginx_status,
        "app_port": app_port,
        "app_http": app_http,
        "web_port": web_port,
        "web_http": web_http,
        "pm2_state": detect_pm2_status(pm2_list),
        "nginx_running": detect_nginx_running(nginx_status),
        "app_listening": detect_listening(app_port, APP_PORT),
        "app_http_ok": detect_http_ok(app_http),
        "web_listening": detect_listening(web_port, WEB_PORT),
        "web_http_ok": detect_http_ok(web_http),
    }


@app.get("/", response_class=HTMLResponse)
def home():
    status = service_status()
    pm2_kind_map = {
        "online": ("运行中", "success"),
        "stopped": ("已停止", "warn"),
        "errored": ("异常", "danger"),
        "missing": ("未创建", "muted"),
        "unknown": ("未知", "warn"),
    }
    pm2_label, pm2_kind = pm2_kind_map.get(status["pm2_state"], ("未知", "warn"))
    nginx_label = "运行中" if status["nginx_running"] else "未运行"
    nginx_kind = "success" if status["nginx_running"] else "danger"
    app_label = "正常" if status["app_listening"] and status["app_http_ok"] else "异常"
    app_kind = "success" if status["app_listening"] and status["app_http_ok"] else "danger"
    web_label = "正常" if status["web_listening"] and status["web_http_ok"] else "异常"
    web_kind = "success" if status["web_listening"] and status["web_http_ok"] else "danger"
    app_hint = summarize_app_hint(status)
    return f"""
    <html>
    <head>
      <meta charset="utf-8">
      <title>Toonflow 管理页</title>
      <style>
        :root {{
          color-scheme: light;
          --bg: #f4f7fb;
          --panel: #ffffff;
          --text: #172033;
          --muted: #60708f;
          --border: #dbe4f0;
          --primary: #2563eb;
          --primary-soft: #dbeafe;
          --success: #16a34a;
          --success-soft: #dcfce7;
          --warn: #d97706;
          --warn-soft: #fef3c7;
          --danger: #dc2626;
          --danger-soft: #fee2e2;
          --muted-soft: #e5e7eb;
          --shadow: 0 18px 50px rgba(15, 23, 42, 0.08);
        }}
        * {{ box-sizing: border-box; }}
        body {{
          margin: 0;
          font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
          background: linear-gradient(180deg, #eef4ff 0%, var(--bg) 220px);
          color: var(--text);
        }}
        .page {{
          max-width: 1200px;
          margin: 0 auto;
          padding: 28px 20px 48px;
        }}
        .hero {{
          background: linear-gradient(135deg, #102244 0%, #1d4ed8 100%);
          color: #fff;
          border-radius: 24px;
          padding: 28px 28px 22px;
          box-shadow: var(--shadow);
        }}
        .hero h1 {{
          margin: 0 0 8px;
          font-size: 34px;
        }}
        .hero p {{
          margin: 0;
          color: rgba(255, 255, 255, 0.82);
          line-height: 1.6;
        }}
        .status-grid {{
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 14px;
          margin: 20px 0 26px;
        }}
        .status-card {{
          background: var(--panel);
          border: 1px solid var(--border);
          border-radius: 18px;
          padding: 18px;
          box-shadow: var(--shadow);
        }}
        .status-top {{
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 10px;
        }}
        .status-title {{
          font-size: 15px;
          font-weight: 700;
        }}
        .status-summary {{
          color: var(--muted);
          font-size: 13px;
          line-height: 1.6;
        }}
        .badge {{
          display: inline-flex;
          align-items: center;
          padding: 6px 10px;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 700;
          white-space: nowrap;
        }}
        .badge-success {{ color: var(--success); background: var(--success-soft); }}
        .badge-warn {{ color: var(--warn); background: var(--warn-soft); }}
        .badge-danger {{ color: var(--danger); background: var(--danger-soft); }}
        .badge-muted {{ color: #4b5563; background: var(--muted-soft); }}
        .panel {{
          background: var(--panel);
          border: 1px solid var(--border);
          border-radius: 20px;
          padding: 18px;
          margin-top: 18px;
          box-shadow: var(--shadow);
        }}
        .panel h2 {{
          margin: 0 0 14px;
          font-size: 20px;
        }}
        .btn-row {{
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
        }}
        .btns a {{
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 42px;
          padding: 0 16px;
          text-decoration: none;
          border: 1px solid var(--border);
          border-radius: 12px;
          color: var(--text);
          background: #fff;
          font-weight: 600;
          transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease;
        }}
        .btns a:hover {{
          transform: translateY(-1px);
          border-color: #bfdbfe;
          background: #f8fbff;
        }}
        .btns a.primary {{
          color: #fff;
          background: var(--primary);
          border-color: var(--primary);
        }}
        .checks {{
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
          gap: 18px;
        }}
        .check-block h3 {{
          margin: 0 0 10px;
          font-size: 16px;
        }}
        .check-tip {{
          margin: 0 0 10px;
          color: var(--muted);
          font-size: 13px;
        }}
        pre {{
          margin: 10px 0 0;
          background: #081120;
          color: #d6f7ff;
          padding: 14px;
          overflow: auto;
          white-space: pre-wrap;
          border-radius: 14px;
          line-height: 1.6;
          border: 1px solid #12203a;
        }}
        .muted {{
          color: var(--muted);
          font-size: 13px;
          line-height: 1.6;
        }}
        @media (max-width: 720px) {{
          .page {{ padding: 18px 14px 32px; }}
          .hero {{ padding: 22px 18px 18px; border-radius: 18px; }}
          .hero h1 {{ font-size: 28px; }}
        }}
      </style>
    </head>
    <body>
      <div class="page">
        <div class="hero">
          <h1>Toonflow 健康管理</h1>
          <p>统一管理 pm2、nginx 和 Toonflow 后端服务。健康检查会同时查看端口监听和 HTTP 响应，避免只看一条 curl 造成误判。</p>
        </div>

        <div class="status-grid">
          {status_card("pm2 进程", f"当前目标进程: {APP_NAME}", pm2_label, pm2_kind)}
          {status_card("nginx", f"反向代理端口: {WEB_PORT}", nginx_label, nginx_kind)}
          {status_card("app 服务", f"监听地址: 127.0.0.1:{APP_PORT}", app_label, app_kind)}
          {status_card("web 入口", f"本机访问: http://127.0.0.1:{WEB_PORT}/", web_label, web_kind)}
        </div>

        <div class="panel btns">
          <h2>快捷操作</h2>
          <div class="btn-row">
            <a class="primary" href="/start_all">启动全部</a>
            <a href="/restart_all">重启全部</a>
            <a href="/stop_all">停止全部</a>
            <a href="/start_app">启动 app</a>
            <a href="/restart_app">重启 app</a>
            <a href="/stop_app">停止 app</a>
            <a href="/start_nginx">启动 nginx</a>
            <a href="/restart_nginx">重启 nginx</a>
            <a href="/stop_nginx">停止 nginx</a>
            <a href="/logs_app">查看 app 日志</a>
            <a href="/logs_nginx">查看 nginx error.log</a>
            <a href="/">刷新状态</a>
            <a href="http://127.0.0.1:{WEB_PORT}/" target="_blank">本机测试 {WEB_PORT}</a>
          </div>
        </div>

        <div class="panel">
          <h2>健康检查</h2>
          <div class="checks">
            <div class="check-block">
              <h3>app 健康检查: 127.0.0.1:{APP_PORT}</h3>
              <p class="check-tip">先检查端口是否监听，再检查 HTTP 是否有响应。连接被拒绝通常表示进程根本没起来；但如果业务页仍然正常，也可能是当前部署并不是直接跑在这台机器的 127.0.0.1:{APP_PORT}。</p>
              <p class="check-tip">{html.escape(app_hint)}</p>
              <pre>{shell_text(status["app_port"] or "(未检测到监听进程)")}</pre>
              <pre>{shell_text(status["app_http"])}</pre>
            </div>
            <div class="check-block">
              <h3>web 健康检查: 127.0.0.1:{WEB_PORT}</h3>
              <p class="check-tip">这里同时检查 nginx 监听和站点响应。若 6006 有 HTTP 头返回，通常说明反代入口已经活着。</p>
              <pre>{shell_text(status["web_port"] or "(未检测到监听进程)")}</pre>
              <pre>{shell_text(status["web_http"])}</pre>
            </div>
          </div>
        </div>

        <div class="panel">
          <h2>pm2 状态</h2>
          <p class="muted">如果这里只显示未创建，说明还没有正确执行过 build/app.js 的 pm2 注册启动。</p>
          <pre>{shell_text(status["pm2_list"])}</pre>
        </div>

        <div class="panel">
          <h2>nginx 状态</h2>
          <pre>{shell_text(status["nginx_status"])}</pre>
        </div>
      </div>
    </body>
    </html>
    """


@app.get("/start_app")
def start_app():
    # 先重启已有进程；如果进程不存在，再按实际脚本路径创建。
    run(
        f"pm2 describe {APP_NAME} >/dev/null 2>&1 && "
        f"pm2 restart {APP_NAME} || "
        f"({START_APP_CMD}) || true"
    )
    return RedirectResponse("/", status_code=302)


@app.get("/restart_app")
def restart_app():
    run(
        f"pm2 describe {APP_NAME} >/dev/null 2>&1 && "
        f"pm2 restart {APP_NAME} || "
        f"({START_APP_CMD}) || true"
    )
    return RedirectResponse("/", status_code=302)


@app.get("/stop_app")
def stop_app():
    run(f"pm2 stop {APP_NAME} || true")
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
    run(
        f"pm2 describe {APP_NAME} >/dev/null 2>&1 && "
        f"pm2 restart {APP_NAME} || "
        f"({START_APP_CMD}) || true"
    )
    return RedirectResponse("/", status_code=302)


@app.get("/restart_all")
def restart_all():
    run(
        f"pm2 describe {APP_NAME} >/dev/null 2>&1 && "
        f"pm2 restart {APP_NAME} || "
        f"({START_APP_CMD}) || true"
    )
    run("service nginx restart || true")
    return RedirectResponse("/", status_code=302)


@app.get("/stop_all")
def stop_all():
    run(f"pm2 stop {APP_NAME} || true")
    run("service nginx stop || true")
    return RedirectResponse("/", status_code=302)


@app.get("/logs_app", response_class=PlainTextResponse)
def logs_app():
    return run(f"pm2 logs {APP_NAME} --lines 100 --nostream || true")


@app.get("/logs_nginx", response_class=PlainTextResponse)
def logs_nginx():
    return run("tail -n 100 /var/log/nginx/error.log || true")
