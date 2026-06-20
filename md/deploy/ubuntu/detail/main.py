from __future__ import annotations

from datetime import datetime
from dataclasses import dataclass
from fastapi import FastAPI
from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse
import html
import os
import shlex
import subprocess

app = FastAPI()

APP_NAME = os.environ.get("PANEL_APP_NAME", "../modify/toonflow-game").strip() or "toonflow-game"
APP_DIR = os.environ.get("PANEL_APP_DIR",
                         "/opt/toonflow/toonflow-game-app").strip() or "/opt/toonflow/toonflow-game-app"
APP_PORT = int(os.environ.get("PANEL_APP_PORT", "60002").strip() or "60002")
WEB_PORT = int(os.environ.get("PANEL_WEB_PORT", "80").strip() or "80")
WEB_SOURCE_DIR = f"{APP_DIR}/scripts/web"
WEB_PUBLISH_DIR = os.environ.get("PANEL_WEB_PUBLISH_DIR", "/var/www/toonflow").strip() or "/var/www/toonflow"
WEB_PROJECT_DIR = os.environ.get("PANEL_WEB_PROJECT_DIR", "").strip()
APP_LOG_DIR = (os.environ.get("PANEL_APP_DIR_LOG", "/data/toonflow/logs").strip()
               or "/data/toonflow/logs")

if not WEB_PROJECT_DIR:
    WEB_PROJECT_DIR = "/opt/toonflow/Toonflow-game-web"
WEB_BUILD_NODE_OPTIONS = os.environ.get("PANEL_WEB_BUILD_NODE_OPTIONS",
                                        "--max-old-space-size=512").strip() or "--max-old-space-size=512"
START_APP_CMD = (
    f"cd {shlex.quote(APP_DIR)} && "
    "NODE_ENV=prod PREFER_PROCESS_ENV=1 "
    f"pm2 start build/app.js --name {shlex.quote(APP_NAME)} --update-env"
)
RESTART_OR_START_APP_CMD = (
    "set -e; "
    f"cd {shlex.quote(APP_DIR)} && "
    f"if pm2 describe {shlex.quote(APP_NAME)} >/dev/null 2>&1; then "
    f"  NODE_ENV=local pm2 restart {shlex.quote(APP_NAME)} --update-env 2>&1; "
    "else "
    f"  NODE_ENV=local pm2 start build/app.js --name {shlex.quote(APP_NAME)} --update-env 2>&1; "
    "fi && "
    "pm2 save 2>&1"
)
LAST_ACTION_LOG = "暂无操作记录"


APP_LOG_FILE = f"{APP_LOG_DIR}/app-$(date +%Y-%m-%d).log"


def get_app_logs(lines: int = 2000) -> str:
    """获取后端应用日志最新N行"""
    today_log = f"{APP_LOG_DIR}/app-{datetime.now().strftime('%Y-%m-%d')}.log"
    if os.path.exists(today_log):
        log_file = today_log
    else:
        # 尝试找最近的日志文件
        try:
            all_logs = sorted([f for f in os.listdir(APP_LOG_DIR) if f.startswith("app-") and f.endswith(".log")])
            log_file = f"{APP_LOG_DIR}/{all_logs[-1]}" if all_logs else None
        except:
            log_file = None

    if not log_file:
        return f"日志文件不存在：{today_log}"

    try:
        with open(log_file, 'r', encoding='utf-8', errors='ignore') as f:
            all_lines = f.readlines()
        return ''.join(all_lines[-lines:])
    except Exception as e:
        return f"读取日志失败：{str(e)}"


def clear_app_logs() -> str:
    """清空后端应用日志（只清空今天的日志）"""
    today_log = f"{APP_LOG_DIR}/app-{datetime.now().strftime('%Y-%m-%d')}.log"
    if not os.path.exists(today_log):
        return f"日志文件不存在：{today_log}"
    try:
        with open(today_log, 'w', encoding='utf-8') as f:
            f.write("")
        return "已清空今日日志"
    except Exception as e:
        return f"清空失败：{str(e)}"


def get_pm2_logs(lines: int = 500) -> str:
    """获取PM2进程日志"""
    result = run(f"pm2 logs {shlex.quote(APP_NAME)} --nostream --lines {lines} 2>&1")
    return result


def clear_pm2_logs() -> str:
    """清空PM2进程日志"""
    return run(f"pm2 flush {shlex.quote(APP_NAME)} 2>&1")


@dataclass
class CommandResult:
    output: str
    returncode: int

    @property
    def ok(self) -> bool:
        return self.returncode == 0


def run_result(cmd: str) -> CommandResult:
    process = subprocess.run(cmd, shell=True, text=True, capture_output=True)
    output = (process.stdout or "") + (process.stderr or "")
    return CommandResult(output=output, returncode=process.returncode)


def run(cmd: str) -> str:
    return run_result(cmd).output


def run_in_repo(cmd: str) -> str:
    return run(f"cd {shlex.quote(APP_DIR)} && {cmd}")


def restart_or_start_app() -> str:
    return run(RESTART_OR_START_APP_CMD)


def git_pull_current_branch(repo_dir: str) -> str:
    safe_dir = shlex.quote(repo_dir)
    return run(
        "set -e; "
        f"cd {safe_dir} && "
        'current_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" && '
        'if [ -z "$current_branch" ] || [ "$current_branch" = "HEAD" ]; then '
        '  echo "无法识别当前分支，已取消 pull。"; '
        "  exit 1; "
        "fi && "
        "git fetch origin --prune 2>&1 && "
        'git pull --ff-only origin "$current_branch" 2>&1'
    )


def sync_web_publish_dir() -> str:
    return run(
        "set -e; "
        f"mkdir -p {shlex.quote(WEB_PUBLISH_DIR)} && "
        f"rsync -a --delete {shlex.quote(WEB_SOURCE_DIR)}/ {shlex.quote(WEB_PUBLISH_DIR)}/ && "
        f"chown -R www-data:www-data {shlex.quote(WEB_PUBLISH_DIR)} && "
        f"chmod -R 755 {shlex.quote(WEB_PUBLISH_DIR)} && "
        # 清理nginx缓存 + 重启
        "nginx -t 2>&1 && systemctl reload nginx 2>&1 && systemctl restart nginx 2>&1"
    )


def sync_web_project_code() -> str:
    return git_pull_current_branch(WEB_PROJECT_DIR)


def build_web_project_command() -> str:
    safe_dir = shlex.quote(WEB_PROJECT_DIR)
    safe_output_dir = shlex.quote(WEB_SOURCE_DIR)
    safe_node_options = shlex.quote(WEB_BUILD_NODE_OPTIONS)
    return (
        "set -e; "
        f'echo "[deploy] 清理旧缓存..." && '
        f"cd {safe_dir} && "
        # ========== 修复：彻底删除旧构建文件，解决Web旧代码问题 ==========
        "rm -rf node_modules dist .cache && "
        'current_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" && '
        "git fetch origin --prune 2>&1 && "
        'git pull --ff-only origin "$current_branch" 2>&1 && '
        "yarn cache clean && "
        "yarn install --frozen-lockfile --ignore-engines 2>&1 && "
        f"export NODE_OPTIONS={safe_node_options} && "
        "yarn build 2>&1 && "
        f"rm -rf {safe_output_dir} && "
        f"mkdir -p {safe_output_dir} && "
        f"rsync -a --delete dist/ {safe_output_dir}/ 2>&1"
    )


def build_web_project() -> str:
    return run(build_web_project_command())


def build_app_project_command() -> str:
    safe_dir = shlex.quote(APP_DIR)
    return (
        "set -e; "
        f'echo "[deploy] 清理旧构建产物..." && '
        f"cd {safe_dir} && "
        # ========== 修复：强制删除旧build文件夹，解决后端旧代码问题 ==========
        "rm -rf build && "
        "yarn install --frozen-lockfile --ignore-engines 2>&1 && "
        "NODE_ENV=prod PREFER_PROCESS_ENV=1 yarn build 2>&1"
    )


def sync_app_project_code() -> str:
    return git_pull_current_branch(APP_DIR)


# ========== 修复：强制同步Git + 语法正确 + 拉取最新远程代码 ==========
def force_sync_repo_current_branch(repo_dir: str) -> str:
    safe_dir = shlex.quote(repo_dir)
    try:
        branch = run(f"cd {safe_dir} && git rev-parse --abbrev-ref HEAD").strip()
    except:
        return f"无法识别仓库当前分支：{repo_dir}"

    if not branch or branch == "HEAD":
        return f"无法识别仓库当前分支：{repo_dir}"

    return run(
        "set -e; "
        f"cd {safe_dir} && "
        f'echo "[deploy] 强制同步分支：{branch}" && '
        # 拉取最新代码 + 强制覆盖本地 + 删除所有本地文件
        "git fetch origin --prune 2>&1 && "
        f"git reset --hard origin/{branch} 2>&1 && "
        "git clean -fd 2>&1"
    )


def deploy_current_app() -> str:
    return run(
        "set -e; "
        f"cd {shlex.quote(APP_DIR)} && "
        'current_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" && '
        "git fetch origin --prune 2>&1 && "
        'git pull --ff-only origin "$current_branch" 2>&1 && '
        # 清理旧build
        "rm -rf build && "
        "yarn install --frozen-lockfile --ignore-engines 2>&1 && "
        "NODE_ENV=prod PREFER_PROCESS_ENV=1 yarn build 2>&1 && "
        f"pm2 restart {shlex.quote(APP_NAME)} --update-env 2>&1 && pm2 save 2>&1"
    )


def get_web_branches() -> list[str]:
    safe_dir = shlex.quote(WEB_PROJECT_DIR)
    output = run(f"cd {safe_dir} && git branch --list --no-color 2>&1 || true")
    branches = []
    for line in output.splitlines():
        line = line.strip()
        if line.startswith("* "):
            branches.append(line[2:].strip())
        elif line:
            branches.append(line.strip())
    return branches


def get_web_current_branch() -> str:
    safe_dir = shlex.quote(WEB_PROJECT_DIR)
    output = run(f"cd {safe_dir} && git rev-parse --abbrev-ref HEAD 2>&1 || true")
    return output.strip() or "unknown"


def switch_web_branch(branch: str) -> str:
    safe_dir = shlex.quote(WEB_PROJECT_DIR)
    safe_branch = shlex.quote(branch)
    return run(
        "set -e; "
        f"cd {safe_dir} && git checkout {safe_branch} && git pull --ff-only origin {safe_branch}"
    )


def switch_app_branch(branch: str) -> str:
    safe_branch = shlex.quote(branch)
    return run_in_repo(
        "set -e; "
        f"git checkout {safe_branch} && git pull --ff-only origin {safe_branch}"
    )


def set_last_action_log(title: str, output: str) -> None:
    global LAST_ACTION_LOG
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    body = (output or "").strip() or "(无输出)"
    LAST_ACTION_LOG = f"[{timestamp}] {title}\n{body}"


# ========== 修复：强制同步后 自动构建+重启，源码立即生效 ==========
def force_sync_current_branch() -> str:
    result = force_sync_repo_current_branch(APP_DIR)
    # 同步后自动构建后端 + 重启
    build_result = run(build_app_project_command())
    restart_result = restart_or_start_app()
    return f"{result}\n\n构建结果：\n{build_result}\n\n重启结果：\n{restart_result}"


def force_sync_web_current_branch() -> str:
    result = force_sync_repo_current_branch(WEB_PROJECT_DIR)
    # 同步后自动构建Web + 发布
    build_result = build_web_project()
    publish_result = sync_web_publish_dir()
    return f"{result}\n\n构建结果：\n{build_result}\n\n发布结果：\n{publish_result}"


def force_sync_all_current_branches() -> str:
    app_output = force_sync_current_branch()
    web_output = force_sync_web_current_branch()
    return f"[APP 同步+构建+重启]\n{app_output}\n\n[WEB 同步+构建+发布]\n{web_output}"


# ====================== 以下代码无需修改 ======================
def shell_text(text: str) -> str:
    return html.escape(text or "").replace("\n", "<br>")


def detect_pm2_status(pm2_text: str) -> str:
    if APP_NAME not in pm2_text: return "missing"
    if "online" in pm2_text: return "online"
    if "stopped" in pm2_text: return "stopped"
    if "errored" in pm2_text: return "errored"
    return "unknown"


def detect_nginx_running(nginx_text: str) -> bool:
    lowered = nginx_text.lower()
    return "active (running)" in lowered or "nginx is running" in lowered


def detect_listening(port_text: str, port: int) -> bool:
    return "listen" in port_text.lower() and f":{port}" in port_text


def detect_http_ok(http_text: str) -> bool:
    return http_text.startswith("HTTP/")


def summarize_app_hint(status: dict) -> str:
    if status["app_listening"] and status["app_http_ok"]:
        return f"app 正在本机 {APP_PORT} 端口提供 HTTP 服务。"
    if status["pm2_state"] == "online" and not status["app_listening"]:
        return f"pm2 进程在线，但 {APP_PORT} 端口未监听。"
    return "未检测到后端服务监听"


def badge(label: str, kind: str) -> str:
    return f'<span class="badge badge-{kind}">{html.escape(label)}</span>'


def detect_action_kind(text: str) -> str:
    lowered = (text or "").lower()
    if any(t in lowered for t in ["fatal:", "error:", "failed"]): return "danger"
    if "up to date" in lowered: return "success"
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
    status_short = run_in_repo("git status --short 2>&1 || true")
    return {
        "current_branch": current_branch or "(未知分支)",
        "current_commit": current_commit or "(未知提交)",
        "dirty": bool((status_short or "").strip()),
    }


def service_status() -> dict:
    pm2_list = run("pm2 jlist")
    nginx_status = run("systemctl status nginx --no-pager 2>&1 || true")
    app_port = run(f"ss -lntp | grep ':{APP_PORT} ' || true")
    app_http = run(f"curl -i -sS --max-time 3 http://127.0.0.1:{APP_PORT}/ || true")
    web_port = run(f"ss -lntp | grep ':{WEB_PORT} ' || true")
    web_http = run(f"curl -I -sS --max-time 3 http://127.0.0.1:{WEB_PORT}/ || true")
    return {
        "pm2_list": pm2_list, "nginx_status": nginx_status,
        "app_port": app_port, "app_http": app_http,
        "web_port": web_port, "web_http": web_http,
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
    web_branches = get_web_branches()
    web_current_branch = get_web_current_branch()
    app_branches = [b.strip().lstrip("* ") for b in run_in_repo("git branch --list").splitlines() if b.strip()]

    pm2_map = {"online": ("运行中", "success"), "stopped": ("已停止", "warn"), "errored": ("异常", "danger"),
               "missing": ("未创建", "muted")}
    pm2_label, pm2_kind = pm2_map.get(status["pm2_state"], ("未知", "warn"))
    nginx_label = "运行中" if status["nginx_running"] else "未运行"
    nginx_kind = "success" if status["nginx_running"] else "danger"
    app_label = "正常" if status["app_http_ok"] else "异常"
    app_kind = "success" if status["app_http_ok"] else "danger"
    web_label = "正常" if status["web_http_ok"] else "异常"
    web_kind = "success" if status["web_http_ok"] else "danger"
    git_label = "有改动" if git["dirty"] else "干净"
    git_kind = "warn" if git["dirty"] else "success"
    action_kind = detect_action_kind(LAST_ACTION_LOG)

    return f"""
    <html>
    <head>
      <meta charset="utf-8">
      <title>Toonflow 管理页</title>
      <style>
        :root {{--bg:#f4f7fb;--panel:#fff;--text:#172033;--muted:#60708f;--border:#dbe4f0;--success:#16a34a;--warn:#d97706;--danger:#dc2626;}}
        *{{box-sizing:border-box}}
        body{{margin:0;font-family:system-ui;background:linear-gradient(180deg,#eef4ff 0%,var(--bg) 220px);}}
        .page{{max-width:1200px;margin:0 auto;padding:28px 20px}}
        .hero{{background:linear-gradient(135deg,#102244 0%,#1d4ed8 100%);color:#fff;border-radius:24px;padding:28px;margin-bottom:20px}}
        .status-grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:20px}}
        .status-card,.panel{{background:var(--panel);border:1px solid var(--border);border-radius:18px;padding:18px}}
        .status-top{{display:flex;justify-content:space-between;align-items:center}}
        .badge{{padding:6px 10px;border-radius:999px;font-size:12px;font-weight:700}}
        .badge-success{{color:#16a34a;background:#dcfce7}}
        .badge-warn{{color:#d97706;background:#fef3c7}}
        .badge-danger{{color:#dc2626;background:#fee2e2}}
        .badge-muted{{color:#4b5563;background:#e5e7eb}}
        .layout{{display:grid;grid-template-columns:1.2fr 0.8fr;gap:18px}}
        .action{{display:inline-flex;align-items:center;justify-content:center;padding:10px 14px;border-radius:14px;text-decoration:none;font-weight:700;margin:5px}}
        .action.danger{{border:1px solid #fecaca;color:#dc2626;background:#fff5f5}}
        .action.dark{{border:1px solid #1d4ed8;color:#fff;background:#1d4ed8}}
        .action{{border:1px solid #cfe0ff;color:#2563eb;background:#f8fbff}}
        /* 核心修复：布局自适应，双栏自动换行 */
        .layout{{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:1rem;}}
        .action{{display:inline-block;padding:0.6rem 1rem;border-radius:12px;text-decoration:none;font-weight:600;margin:0.3rem;border:1px solid var(--border);}}
        .action-primary{{background:#1d4ed8;color:#fff;border-color:#1d4ed8;}}
        .action-danger{{background:#fff5f5;color:#dc2626;border-color:#fecaca;}}
        .action-default{{background:#f8fbff;color:#2563eb;}}
        pre{{background:#081120;color:#dbeafe;border-radius:16px;padding:1rem;max-height:400px;overflow:auto;font-size:0.8rem;}}
        form{{margin:1rem 0;}}
        select{{padding:0.5rem;border-radius:8px;border:1px solid var(--border);margin-right:0.5rem;}}
        button{{cursor:pointer;}}

      </style>
    </head>
    <body>
      <div class="page">
        <div class="hero"><h1>Toonflow 管理页</h1><p>目录：{APP_DIR}<br>端口：后端{APP_PORT} | Web{WEB_PORT}</p></div>
        <div class="status-grid">
          {status_card("PM2进程", f"名称：{APP_NAME}", pm2_label, pm2_kind)}
          {status_card("Nginx", "Web服务", nginx_label, nginx_kind)}
          {status_card("后端服务", f"端口{APP_PORT}", app_label, app_kind)}
          {status_card("Web入口", f"端口{WEB_PORT}", web_label, web_kind)}
          {status_card("Git仓库", f"{git['current_branch']}@{git['current_commit']}", git_label, git_kind)}
        </div>
        <div class="layout">
          <div class="panel">
            <h2>服务操作</h2>
            <a class="action danger" href="/git/force-sync-all">🔥 强制全量更新&重启（推荐）</a>
            <a class="action danger" href="/git/force-sync">强制更新后端</a>
            <a class="action danger" href="/git/force-sync-web">强制更新Web</a>
            <br>
            <a class="action dark" href="/deploy/sync-web">构建Web端</a>
            <a class="action" href="/nginx/restart">重启Nginx</a>
            <a class="action dark" href="/app/restart">重启后端</a>
            <a class="action dark" href="/app/logs">📜 查看日志</a>
            <a class="action dark" href="/app/pm2-logs">📋 PM2日志</a>
            <br>
            <form action="/git/switch-branch" method="get" style="margin-top:10px">
              <label>切换Web分支：</label>
              <select name="branch">{''.join(f'<option value="{b}"{"selected" if b == web_current_branch else ""}>{b}</option>' for b in web_branches)}</select>
              <button class="action dark" type="submit">切换并构建</button>
            </form>
            <form action="/git/switch-app-branch" method="get" style="margin-top:10px">
              <label>切换后端分支：</label>
              <select name="branch">{''.join(f'<option value="{b}"{"selected" if b == git["current_branch"] else ""}>{b}</option>' for b in app_branches)}</select>
              <button class="action dark" type="submit">切换并发布</button>
            </form>
          </div>
          <div class="panel">
            <h2>操作日志</h2>
            <pre>{html.escape(LAST_ACTION_LOG)}</pre>
          </div>
        </div>
      </div>
    </body>
    </html>
    """


@app.get("/app/restart")
def app_restart():
    output = run(build_app_project_command()) + "\n\n" + restart_or_start_app()
    set_last_action_log("重启后端（全新构建）", output)
    return RedirectResponse("/")


@app.get("/nginx/restart")
def nginx_restart():
    output = run("nginx -t && systemctl restart nginx")
    set_last_action_log("重启Nginx", output)
    return RedirectResponse("/")


@app.get("/deploy/sync-web")
def deploy_sync_web():
    build = run_result(build_web_project_command())
    if not build.ok:
        set_last_action_log("Web构建失败", build.output)
        return RedirectResponse("/")
    publish = run_result(f"rsync -a --delete {WEB_SOURCE_DIR}/ {WEB_PUBLISH_DIR}/ && systemctl reload nginx")
    set_last_action_log("Web构建+发布成功", build.output + "\n" + publish.output)
    return RedirectResponse("/")


@app.get("/git/switch-branch")
def git_switch_branch(branch: str = ""):
    if not branch: return RedirectResponse("/")
    output = switch_web_branch(branch) + "\n\n" + build_web_project() + "\n\n" + sync_web_publish_dir()
    set_last_action_log(f"Web切换分支：{branch}", output)
    return RedirectResponse("/")


@app.get("/git/switch-app-branch")
def git_switch_app_branch(branch: str = ""):
    if not branch: return RedirectResponse("/")
    output = switch_app_branch(branch) + "\n\n" + run(build_app_project_command()) + "\n\n" + restart_or_start_app()
    set_last_action_log(f"后端切换分支：{branch}", output)
    return RedirectResponse("/")


@app.get("/git/force-sync")
def git_force_sync():
    output = force_sync_current_branch()
    set_last_action_log("后端：强制同步+构建+重启", output)
    return RedirectResponse("/")


@app.get("/git/force-sync-web")
def git_force_sync_web():
    output = force_sync_web_current_branch()
    set_last_action_log("Web：强制同步+构建+发布", output)
    return RedirectResponse("/")


@app.get("/git/force-sync-all")
def git_force_sync_all():
    output = force_sync_all_current_branches()
    set_last_action_log("🔥 全量更新：同步+构建+重启+发布", output)
    return RedirectResponse("/")


@app.get("/healthz", response_class=PlainTextResponse)
def healthz():
    return "ok"


@app.get("/app/logs", response_class=HTMLResponse)
def view_app_logs():
    """查看后端应用日志"""
    lines = 2000
    logs = get_app_logs(lines)
    logs_escaped = html.escape(logs).replace("\n", "<br>")

    return f"""
    <html>
    <head>
      <meta charset="utf-8">
      <title>后端日志 - Toonflow</title>
      <style>
        body {{font-family:monospace;background:#0a0a0a;color:#4ade80;margin:0;padding:20px}}
        h1 {{color:#fff;margin-bottom:20px;display:flex;align-items:center;gap:10px}}
        a {{color:#60a5fa;margin-right:20px;text-decoration:none}}
        pre {{background:#111;padding:20px;border-radius:8px;max-height:80vh;overflow:auto;font-size:12px;line-height:1.4}}
        .timestamp {{color:#fbbf24}}
        .error {{color:#f87171}}
        .warn {{color:#fbbf24}}
        .btn-clear {{
          background:#dc2626;color:#fff;border:none;padding:8px 16px;border-radius:6px;
          cursor:pointer;font-size:14px;font-weight:600
        }}
        .btn-clear:hover {{background:#b91c1c}}
        .actions {{display:flex;align-items:center;gap:10px;margin-bottom:10px}}
      </style>
    </head>
    <body>
      <h1>后端日志 (最新{lines}行)</h1>
      <div class="actions">
        <a href="/">返回管理页</a>
        <a href="/app/logs?refresh=1">刷新</a>
        <a href="/app/pm2-logs">PM2日志</a>
        <form action="/app/logs/clear" method="post" style="display:inline">
          <button class="btn-clear" type="submit" onclick="return confirm('确定要清空今日后端日志吗？')">🗑 清空日志</button>
        </form>
      </div>
      <pre>{logs_escaped}</pre>
    </body>
    </html>
    """


@app.post("/app/logs/clear")
def clear_app_logs_handler():
    """清空后端应用日志"""
    output = clear_app_logs()
    set_last_action_log("清空后端日志", output)
    return RedirectResponse("/app/logs", status_code=303)


@app.get("/app/pm2-logs", response_class=HTMLResponse)
def view_pm2_logs():
    """查看PM2进程日志"""
    lines = 500
    logs = get_pm2_logs(lines)
    logs_escaped = html.escape(logs).replace("\n", "<br>")

    return f"""
    <html>
    <head>
      <meta charset="utf-8">
      <title>PM2日志 - Toonflow</title>
      <style>
        body {{font-family:monospace;background:#0a0a0a;color:#4ade80;margin:0;padding:20px}}
        h1 {{color:#fff;margin-bottom:20px;display:flex;align-items:center;gap:10px}}
        a {{color:#60a5fa;margin-right:20px;text-decoration:none}}
        pre {{background:#111;padding:20px;border-radius:8px;max-height:80vh;overflow:auto;font-size:12px;line-height:1.4}}
        .btn-clear {{
          background:#dc2626;color:#fff;border:none;padding:8px 16px;border-radius:6px;
          cursor:pointer;font-size:14px;font-weight:600
        }}
        .btn-clear:hover {{background:#b91c1c}}
        .actions {{display:flex;align-items:center;gap:10px;margin-bottom:10px}}
      </style>
    </head>
    <body>
      <h1>PM2日志 (最新{lines}行)</h1>
      <div class="actions">
        <a href="/">返回管理页</a>
        <a href="/app/logs">应用日志</a>
        <a href="/app/pm2-logs">刷新</a>
        <form action="/app/pm2-logs/clear" method="post" style="display:inline">
          <button class="btn-clear" type="submit" onclick="return confirm('确定要清空PM2日志吗？')">🗑 清空日志</button>
        </form>
      </div>
      <pre>{logs_escaped}</pre>
    </body>
    </html>
    """


@app.post("/app/pm2-logs/clear")
def clear_pm2_logs_handler():
    """清空PM2进程日志"""
    output = clear_pm2_logs()
    set_last_action_log("清空PM2日志", output)
    return RedirectResponse("/app/pm2-logs", status_code=303)