#!/bin/sh
# 语法体检：把 tidings-panel.html 里真正的 <script> 块抽出来交给 node --check。
#
# 为什么不能只写一句 sed：这个文件里 CSS 注释、注解文案都可能出现 "<script>" 字样
# （不是标签，只是文字），朴素的 `<script[^>]*>(.*?)</script>` 会从那个字面量开始切，
# 抽出半截 CSS 去给 node 解析，报一个跟真实问题无关的错。
# 这里改用「只认行首就是 <script> 的那一行」，并且只抽不带 src 的块。
set -e
cd "$(dirname "$0")"
python3 - <<'PY'
import re
src = open('tidings-panel.html', encoding='utf-8').read()
blocks = re.findall(r'^<script>\n(.*?)^</script>$', src, re.S | re.M)
assert blocks, "没找到 <script> 块"
js = "\n".join(blocks)
open('/tmp/tidings-panel-check.js', 'w', encoding='utf-8').write(js)
print("抽出 %d 个 script 块，%d 字符" % (len(blocks), len(js)))
PY
node --check /tmp/tidings-panel-check.js
echo "tidings-panel.html 语法 OK"
