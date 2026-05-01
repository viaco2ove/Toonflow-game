from __future__ import annotations

from datetime import datetime
from fastapi import FastAPI
from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse
import html
import os
import shlex
import subprocess

app = FastAPI()

APP_NAME = os.environ.get("PANEL_APP_NAME", "toonflow-game").strip() or "toonflow-game"
APP_DIR = os.environ.get("PANEL_APP_DIR", "/opt/toonflow/toonflow-game-app").strip() or "/opt/toonflow/toonflow-game-app"
APP_PORT = int(os.environ.get("PANEL_APP_PORT", "60002").strip() or "60002")
WEB_PORT = int(os.environ.get("PANEL_WEB_PORT", "80").strip() or "80")
WEB_SOURCE_DIR = f"{APP_DIR}/scripts/web"
WEB_PUBLISH_DIR = os.environ.get("PANEL_WEB_PUBLISH_DIR", "/var/www/toonflow").strip() or "/var/www/toonflow"
START_APP_CMD = (
    f"cd {shlex.quote(APP_DIR)} && "
    "NODE_ENV=prod PREFER_PROCESS_ENV=1 "
    f"pm2 start build/app.js --name {shlex.quote(APP_NAME)} --update-env"
)
LAST_ACTION_LOG = "暂无操作记录"


def run(cmd: str) -> str:
    process = subprocess.run(cmd, shell=True, text=True, capture_output=True)
    return (process.stdout or "") + (process.stderr or "")


def run_in_repo(cmd: str) -> str:
    return run(f"cd {shlex.quote(APP_DIR)} && {cmd}")


def sync_web_publish_dir() -> str:
    return run(
        f"mkdir -p {shlex.quote(WEB_PUBLISH_DIR)} && "
        f"rsync -a --delete {shlex.quote(WEB_SOURCE_DIR)}/ {shlex.quote(WEB_PUBLISH_DIR)}/ && "
        f"chown -R www-data:www-data {shlex.quote(WEB_PUBLISH_DIR)} && "
        f"chmod -R 755 {shlex.quote(WEB_PUBLISH_DIR)} && "
        "nginx -t >/dev/null 2>&1 && systemctl reload nginx >/dev/null 2>&1 || true"
    )


def set_last_action_log(title: str, output: str) -> None:
    global LAST_ACTION_LOG
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    body = (output or "").strip() or "(无输出)"
    LAST_ACTION_LOG = f"[{timestamp}] {title}\n{body}"


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
    return "active (running)" in lowered or "nginx is running" in lowered or lowered.strip() == "active"


def detect_listening(port_text: str, port: int) -> bool:
    return "listen" in port_text.lower() and f":{port}" in port_text


def detect_http_ok(http_text: str) -> bool:
    return http_text.startswith("HTTP/")


def summarize_app_hint(status: dict) -> str:
    if status["app_listening"] and status["app_http_ok"]:
        return f"app 正在本机 {APP_PORT} 端口提供 HTTP 服务。"
    if status["pm2_state"] == "online" and not status["app_listening"]:
        return f"pm2 显示进程在线，但本机没有检测到 {APP_PORT} 监听。请检查 pm2 启动命令和环境变量。"
    if status["web_http_ok"] and not status["app_listening"]:
        return f"web 入口正常，但本机 {APP_PORT} 没监听。请检查 nginx upstream 和后端进程。"
    return "当前没有检测到 app 本机监听。"


def badge(label: str, kind: str) -> str:
    return f'<span class="badge badge-{kind}">{html.escape(label)}</span>'


def detect_action_kind(text: str) -> str:
    lowered = (text or "").lower()
    if any(token in lowered for token in ["fatal:", "error:", "conflict", "failed", "aborting", "not found"]):
        return "danger"
    if "already up to date" in lowered or "up to date" in lowered:
        return "success"
    if any(token in lowered for token in ["files changed", "changed", "updating", "fast-forward", "switched to branch"]):
        return "success"
    return "muted"


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


def git_info() -> dict:
    current_branch = run_in_repo("git rev-parse --abbrev-ref HEAD 2>&1 || true").strip()
    current_commit = run_in_repo("git rev-parse --short HEAD 2>&1 || true").strip()
    branch_list = run_in_repo("git branch --list --no-color 2>&1 || true")
    status_short = run_in_repo("git status --short 2>&1 || true")
    status_full = run_in_repo("git status -sb 2>&1 || true")
    return {
        "current_branch": current_branch or "(未知分支)",
        "current_commit": current_commit or "(未知提交)",
        "branch_list": branch_list,
        "status_short": status_short,
        "status_full": status_full,
        "dirty": bool((status_short or "").strip()),
    }


def force_sync_current_branch() -> str:
    branch = run_in_repo("git rev-parse --abbrev-ref HEAD 2>&1 || true").strip()
    safe_branch = shlex.quote(branch)
    if not branch or branch == "HEAD":
        return "无法识别当前分支，已取消强制同步。"
    return run_in_repo(
        "git fetch origin --prune 2>&1 && "
        f"git reset --hard origin/{safe_branch} 2>&1 && "
        "git clean -fd 2>&1 || true"
    )


def service_status() -> dict:
    pm2_list = run("pm2 jlist")
    nginx_status = run("systemctl status nginx --no-pager 2>&1 || service nginx status 2>&1 || true")
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
def home() -> str:
    status = service_status()
    git = git_info()
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
    git_label = "有改动" if git["dirty"] else "干净"
    git_kind = "warn" if git["dirty"] else "success"
    action_kind = detect_action_kind(LAST_ACTION_LOG)
    app_hint = summarize_app_hint(status)

    return f"""
    <html>
    <head>
      <meta charset="utf-8">
      <title>Toonflow 管理页</title>
      <style>
        :root {{
          --bg: #f4f7fb;
          --panel: #ffffff;
          --text: #172033;
          --muted: #60708f;
          --border: #dbe4f0;
          --primary: #2563eb;
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
        .hero h1 {{ margin: 0 0 8px; font-size: 34px; }}
        .hero p {{ margin: 0; color: rgba(255, 255, 255, 0.82); line-height: 1.6; }}
        .status-grid {{
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 14px;
          margin: 20px 0 26px;
        }}
        .status-card, .panel {{
          background: var(--panel);
          border: 1px solid var(--border);
          border-radius: 18px;
          padding: 18px;
          box-shadow: var(--shadow);
        }}
        .status-top {{
          display: flex;
          justify-content: space-between;
          gap: 12px;
          align-items: center;
          margin-bottom: 8px;
        }}
        .status-title {{
          font-size: 15px;
          font-weight: 800;
        }}
        .status-summary {{
          color: var(--muted);
          font-size: 13px;
          line-height: 1.6;
        }}
        .badge {{
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 78px;
          padding: 6px 10px;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 700;
        }}
        .badge-success {{ color: var(--success); background: var(--success-soft); }}
        .badge-warn {{ color: var(--warn); background: var(--warn-soft); }}
        .badge-danger {{ color: var(--danger); background: var(--danger-soft); }}
        .badge-muted {{ color: #4b5563; background: var(--muted-soft); }}
        .layout {{
          display: grid;
          grid-template-columns: 1.2fr 0.8fr;
          gap: 18px;
        }}
        .panel h2 {{
          margin: 0 0 12px;
          font-size: 18px;
        }}
        .subtle {{
          color: var(--muted);
          font-size: 13px;
          line-height: 1.6;
        }}
        .row {{
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          margin-top: 14px;
        }}
        .action {{
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 120px;
          border: 1px solid #cfe0ff;
          border-radius: 14px;
          padding: 10px 14px;
          text-decoration: none;
          color: var(--primary);
          font-weight: 700;
          background: #f8fbff;
        }}
        .action.danger {{
          border-color: #fecaca;
          color: var(--danger);
          background: #fff5f5;
        }}
        .action.dark {{
          border-color: #1d4ed8;
          color: #fff;
          background: #1d4ed8;
        }}
        pre {{
          margin: 0;
          white-space: pre-wrap;
          word-break: break-word;
          line-height: 1.5;
          font-size: 12px;
          background: #081120;
          color: #dbeafe;
          border-radius: 16px;
          padding: 16px;
          max-height: 520px;
          overflow: auto;
        }}
        .meta {{
          display: grid;
          gap: 8px;
          margin-top: 12px;
          font-size: 13px;
          color: var(--muted);
        }}
        @media (max-width: 920px) {{
          .layout {{ grid-template-columns: 1fr; }}
          .hero h1 {{ font-size: 28px; }}
        }}
      </style>
    </head>
    <body>
      <div class="page">
        <section class="hero">
          <h1>Toonflow 管理页</h1>
          <p>目录：{html.escape(APP_DIR)}<br>app 端口：{APP_PORT}，web 端口：{WEB_PORT}</p>
        </section>

        <section class="status-grid">
          {status_card("PM2 进程", f"进程名：{APP_NAME}", pm2_label, pm2_kind)}
          {status_card("Nginx", "Web 入口转发与静态页服务", nginx_label, nginx_kind)}
          {status_card("后端 HTTP", app_hint, app_label, app_kind)}
          {status_card("Web 入口", f"检测 127.0.0.1:{WEB_PORT}", web_label, web_kind)}
          {status_card("Git 工作区", f"{git['current_branch']} @ {git['current_commit']}", git_label, git_kind)}
        </section>

        <section class="layout">
          <div class="panel">
            <h2>服务操作</h2>
            <div class="subtle">这些操作会直接对当前 Ubuntu 服务器上的真实服务生效。</div>
            <div class="row">
              <a class="action dark" href="/app/start">启动 app</a>
              <a class="action" href="/app/restart">重启 app</a>
              <a class="action danger" href="/app/stop">停止 app</a>
            </div>
            <div class="row">
              <a class="action dark" href="/nginx/start">启动 nginx</a>
              <a class="action" href="/nginx/restart">重启 nginx</a>
              <a class="action danger" href="/nginx/stop">停止 nginx</a>
            </div>
            <div class="row">
              <a class="action" href="/deploy/sync-web">同步静态页</a>
              <a class="action danger" href="/git/force-sync">强制同步当前分支</a>
            </div>
            <div class="meta">
              <div>当前分支：{html.escape(git["current_branch"])}</div>
              <div>当前提交：{html.escape(git["current_commit"])}</div>
            </div>
          </div>

          <div class="panel">
            <h2>最近操作</h2>
            {badge("最近日志", action_kind)}
            <div style="margin-top: 12px;">
              <pre>{html.escape(LAST_ACTION_LOG)}</pre>
            </div>
          </div>
        </section>
      </div>
    </body>
    </html>
    """


@app.get("/app/start")
def app_start():
    output = run(START_APP_CMD)
    set_last_action_log("启动 app", output)
    return RedirectResponse("/", status_code=302)


@app.get("/app/restart")
def app_restart():
    output = run(f"pm2 restart {shlex.quote(APP_NAME)} --update-env 2>&1 || true")
    set_last_action_log("重启 app", output)
    return RedirectResponse("/", status_code=302)


@app.get("/app/stop")
def app_stop():
    output = run(f"pm2 stop {shlex.quote(APP_NAME)} 2>&1 || true")
    set_last_action_log("停止 app", output)
    return RedirectResponse("/", status_code=302)


@app.get("/nginx/start")
def nginx_start():
    output = run("systemctl start nginx 2>&1 || service nginx start 2>&1 || true")
    set_last_action_log("启动 nginx", output)
    return RedirectResponse("/", status_code=302)


@app.get("/nginx/restart")
def nginx_restart():
    output = run("nginx -t 2>&1 && (systemctl restart nginx 2>&1 || service nginx restart 2>&1) || true")
    set_last_action_log("重启 nginx", output)
    return RedirectResponse("/", status_code=302)


@app.get("/nginx/stop")
def nginx_stop():
    output = run("systemctl stop nginx 2>&1 || service nginx stop 2>&1 || true")
    set_last_action_log("停止 nginx", output)
    return RedirectResponse("/", status_code=302)


@app.get("/deploy/sync-web")
def deploy_sync_web():
    output = sync_web_publish_dir()
    set_last_action_log("同步静态页", output)
    return RedirectResponse("/", status_code=302)


@app.get("/git/force-sync")
def git_force_sync():
    output = force_sync_current_branch()
    output += "\n\n" + sync_web_publish_dir()
    set_last_action_log("强制同步当前分支", output)
    return RedirectResponse("/", status_code=302)


@app.get("/healthz", response_class=PlainTextResponse)
def healthz():
    return "ok"
