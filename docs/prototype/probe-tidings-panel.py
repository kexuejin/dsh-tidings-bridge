#!/usr/bin/env python3
"""几何探针：把 tidings-panel.html 的每一屏都渲染一遍，量真实盒模型，报三件事。

  · clip-x    内容比容器宽、容器又不让滚 —— 会被切掉（省略号是允许的）
  · clip-y    内容比容器高、容器 overflow:hidden —— 会被切掉
  · outside-x 元素伸出窗口框（滚动容器里的除外）

退出码非 0 = 有发现。生成物只写 /tmp，不落在仓库里。
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import html as H

HERE = os.path.dirname(os.path.abspath(__file__))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

PROBE = r"""
<script>
(function(){
  const out = { screens: [], spacing: {} };
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0;';
  document.body.appendChild(host);

  const FORMS = ['wide-dark','wide-light','narrow-dark'];
  const PAIRS = [];
  SCREENS.forEach(s => FORMS.forEach(f => PAIRS.push([s.id, f, s.label + ' @ ' + f])));

  function snap(el){
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    return {x:+r.left.toFixed(1), y:+r.top.toFixed(1),
            w:+r.width.toFixed(1), h:+r.height.toFixed(1),
            pad:cs.padding, mar:cs.margin, gap:cs.rowGap};
  }
  function measure(sid, sk, label){
    host.innerHTML = device(sid, sk);
    const dev = host.querySelector('.win');
    if (!dev) return {screen: sid, form: sk, label, n: 1, issues: [{t:'fatal'}]};
    const dr = dev.getBoundingClientRect();
    const iss = [];
    host.querySelectorAll('*').forEach(el => {
      const cs = getComputedStyle(el);
      const hx = el.scrollWidth - el.clientWidth;
      if (hx > 1 && el.clientWidth > 0 && cs.textOverflow !== 'ellipsis'
          && cs.overflowX !== 'visible' && cs.overflowX !== 'auto' && cs.overflowX !== 'scroll') {
        iss.push({t:'clip-x', sel:String(el.className||el.tagName), over:hx,
                  txt:(el.textContent||'').trim().slice(0,40)});
      }
      const hy = el.scrollHeight - el.clientHeight;
      if (hy > 1 && el.clientHeight > 0 && cs.overflowY === 'hidden') {
        iss.push({t:'clip-y', sel:String(el.className||el.tagName), over:hy,
                  txt:(el.textContent||'').trim().slice(0,40)});
      }
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      if ((r.right > dr.right + 1.5 || r.left < dr.left - 1.5)
          && !el.closest('.scroll') && !el.closest('.menu')) {
        iss.push({t:'outside-x', sel:String(el.className||el.tagName),
                  d:+(r.right-dr.right).toFixed(1)});
      }
    });
    return {screen: sid, form: sk, label, n: iss.length, issues: iss.slice(0, 12)};
  }

  PAIRS.forEach(p => out.screens.push(measure(p[0], p[1], p[2])));

  function row(sid, sk, sels){
    host.innerHTML = device(sid, sk);
    return sels.map(s => { const e = host.querySelector(s); return e ? {sel:s, ...snap(e)} : null; })
               .filter(Boolean);
  }
  out.spacing['最近会话 @ 宽窗'] = row('p-home', 'wide-dark',
    ['.phead', '.psub', '.nodebar', '.banner', '.search', '.chips', '.rows', '.crow', '.cbody', '.annot']);
  out.spacing['最近会话 @ 窄窗'] = row('p-home', 'narrow-dark',
    ['.phead', '.psub', '.nodebar', '.search', '.chips', '.rows', '.crow', '.cbody']);
  out.spacing['对话 @ 窄窗'] = row('p-thread', 'narrow-dark',
    ['.thead', '.msgs', '.msg', '.composer']);

  host.remove();
  document.body.innerHTML = '<pre id="__probe__">' + JSON.stringify(out) + '</pre>';
})();
</script>
"""


def main():
    base = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4181").rstrip("/")
    src = open(os.path.join(HERE, "tidings-panel.html"), encoding="utf-8").read()
    out_path = os.path.join(HERE, "_probe-tidings-panel.html")
    open(out_path, "w", encoding="utf-8").write(src.replace("</body>", PROBE + "</body>", 1))
    profile = tempfile.mkdtemp(prefix="probe-")
    try:
        p = subprocess.Popen(
            [CHROME, "--headless", "--no-sandbox", "--disable-gpu",
             "--disable-dev-shm-usage", "--no-proxy-server",
             "--user-data-dir=" + profile, "--virtual-time-budget=8000",
             "--dump-dom", base + "/" + os.path.basename(out_path)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            out, err = p.communicate(timeout=240)
        except subprocess.TimeoutExpired:
            p.kill(); out, err = p.communicate()
    finally:
        shutil.rmtree(profile, ignore_errors=True)
        if os.path.exists(out_path):
            os.remove(out_path)

    m = re.search(r'<pre id="__probe__">(.*?)</pre>', out, re.S)
    if not m:
        print("探针没跑出来（页面可能整段报错）。stderr 尾部：", file=sys.stderr)
        print((err or "")[-800:], file=sys.stderr)
        return 2

    data = json.loads(H.unescape(m.group(1)))
    json.dump(data, open("/tmp/tidings-panel-probe.json", "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)

    total = sum(s["n"] for s in data["screens"])
    print("渲染 %d 屏，发现 %d 处\n" % (len(data["screens"]), total))
    for s in data["screens"]:
        if not s["n"]:
            continue
        print("[%s @ %s] %d 处" % (s["screen"], s["form"], s["n"]))
        for i in s["issues"]:
            extra = i.get("txt") or ("+" + str(i.get("d", "")) + "px")
            print("    %-10s %-28s %s" % (i["t"], i["sel"][:28], extra))
        print()
    print("──── 间距快照（页面 px）────")
    for name, rows in data["spacing"].items():
        print("\n%s" % name)
        print("  %-10s %7s %7s %7s  %-22s margin" % ("选择器", "x", "w", "h", "padding"))
        for r in rows:
            print("  %-10s %7s %7s %7s  %-22s %s" % (r['sel'], r['x'], r['w'], r['h'], r['pad'], r['mar']))
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main())
