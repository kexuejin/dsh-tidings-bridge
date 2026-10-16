#!/usr/bin/env python3
"""把 tidings-panel.html 的每一屏渲染成 PNG，供逐张人眼验收。

用法：先起静态服务器，再 python3 shoot-tidings-panel.py [关键词...]
    python3 -m http.server 4181 --bind 127.0.0.1
    python3 shoot-tidings-panel.py           # 全部
    python3 shoot-tidings-panel.py thread    # 只跑名字里含关键词的

为什么不用 file:// 直开：本机的 --headless 在 file:// + 查询串下会挂住不返回，
必须走 HTTP。为什么加 --no-proxy-server：本机配了 HTTP_PROXY（FlClash/Clash），
不显式绕开的话 Chrome 会把 127.0.0.1 也丢给代理，拿到 502 后静默截一张空白页。

窗口尺寸 = 画布本体。截图模式下 `.stage.shot` 把 padding 清零、`.win` 去掉圆角与
投影，所以窗口宽高就是画布宽高，不需要再加留白。
"""
import os
import shutil
import subprocess
import sys
import tempfile
import time

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
# 结尾带 ? —— 后面是拼 &size=…&screen=…&theme=…。少了这个 ? 整个查询串会被当成
# 路径的一部分，Chrome 拿到 404，于是 21 张图字节数一模一样（全是空白页）。
BASE = "http://127.0.0.1:4181/tidings-panel.html?"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "screenshots")

# (名字, 屏, 形态, 主题, 窗口宽, 窗口高, 追加查询)
# 形态在 tidings-panel.html 的 FORMS 里定义： wide 1440×900（侧栏 280）/ narrow 600×760（侧栏 56）
SHOTS = [
    # ---- 列表：提案的默认落点 ----
    ("p01-home",             "p-home",         "wide-dark",   "dark",   1440, 900),
    ("p02-home-empty",       "p-home-empty",   "wide-dark",   "dark",   1440, 900),
    ("p03-home-filter",      "p-home-filter",  "wide-dark",   "dark",   1440, 900),
    ("p04-more",             "p-more",         "wide-dark",   "dark",   1440, 900),
    # ---- 对话 ----
    ("p05-thread",           "p-thread",       "wide-dark",   "dark",   1440, 900),
    ("p06-thread-empty",     "p-thread-empty", "wide-dark",   "dark",   1440, 900),
    ("p07-thread-queued",    "p-thread-queued","wide-dark",   "dark",   1440, 900),
    ("p08-compose",          "p-compose",      "wide-dark",   "dark",   1440, 900),
    # ---- 异常 ----
    ("p09-unreachable",      "p-unreachable",  "wide-dark",   "dark",   1440, 900),
    ("p10-unauthorized",     "p-unauthorized", "wide-dark",   "dark",   1440, 900),
    ("p11-loading",          "p-loading",      "wide-dark",   "dark",   1440, 900),
    # ---- 设置 ----
    ("p12-settings",         "p-settings",     "wide-dark",   "dark",   1440, 900),
    ("p13-credential",       "p-credential",   "wide-dark",   "dark",   1440, 900),
    # ---- 浅色：同一屏换主题，用来盯深浅两套 token ----
    ("p14-home-light",       "p-home",         "wide-light",  "light",  1440, 900),
    ("p15-thread-light",     "p-thread",       "wide-light",  "light",  1440, 900),
    ("p16-settings-light",   "p-settings",     "wide-light",  "light",  1440, 900),
    ("p17-unreach-light",    "p-unreachable",  "wide-light",  "light",  1440, 900),
    # ---- 窄窗：侧栏收到 56px，面板只剩 544 宽，最容易挤 ----
    ("p18-home-narrow",      "p-home",         "narrow-dark", "dark",    600, 760),
    ("p19-thread-narrow",    "p-thread",       "narrow-dark", "dark",    600, 760),
    ("p20-settings-narrow",  "p-settings",     "narrow-dark", "dark",    600, 760),
    ("p21-compose-narrow",   "p-compose",      "narrow-dark", "dark",    600, 760),
]


def shoot(name, screen, form, theme, w, h, extra=""):
    os.makedirs(OUT, exist_ok=True)
    dest = os.path.join(OUT, name + ".png")
    if os.path.exists(dest):
        os.remove(dest)
    profile = tempfile.mkdtemp(prefix="shot-")
    cmd = [
        CHROME,
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--hide-scrollbars",
        "--no-proxy-server",
        "--user-data-dir=" + profile,
        "--force-device-scale-factor=1",
        "--window-size=%d,%d" % (w, h),
        "--screenshot=" + dest,
        "%s&size=%s&screen=%s&theme=%s%s" % (BASE, form, screen, theme, extra),
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + 45
    while time.time() < deadline:
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            break
        if proc.poll() is not None:
            break
        time.sleep(0.25)
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    shutil.rmtree(profile, ignore_errors=True)
    if not os.path.exists(dest) or os.path.getsize(dest) == 0:
        return "FAIL  %s" % name
    return "ok    %-24s %8d bytes" % (name + ".png", os.path.getsize(dest))


def main():
    keys = sys.argv[1:]
    shots = [s for s in SHOTS if not keys or any(k in s[0] for k in keys)]
    bad = 0
    for shot in shots:
        line = shoot(*shot)
        print(line, flush=True)
        if line.startswith("FAIL"):
            bad += 1
    print("\n共 %d 张，失败 %d 张 -> %s" % (len(shots), bad, OUT))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
