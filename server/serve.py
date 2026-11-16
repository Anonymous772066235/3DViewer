# -*- coding: utf-8 -*-
"""
一体化本地服务：静态页面 + 孔位优化桥接（同源，默认 http://127.0.0.1:8765）

这样"打开页面"和"能点孔位优化"是同一件事：
  - 只要通过 serve.bat 打开，页面与 /optimize 一定同时可用，不会出现"忘了启动 bridge"
  - 端点： GET  /health   GET /log   POST /optimize   其余路径按静态文件返回
环境变量：VIEWER_PORT（默认 8765）、HOLEOPT_EXE / HOLEOPT_PROJECT / HOLEOPT_DATA / HOLEOPT_TIMEOUT
"""
import mimetypes
import os
import shutil
import sys
import threading
import urllib.parse
import webbrowser
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)   # bridge.py 与本文件同目录

import bridge as opt   # noqa: E402  （服务端模块统一在 server/ 下）

PORT = int(os.environ.get('VIEWER_PORT', '8765'))
ROOT = os.path.dirname(HERE)   # 静态资源根 = 3DViewer/

"""静态资源的 MIME 必须【硬编码】，不能用 mimetypes.guess_type 直接猜。

Windows 上 Python 的 mimetypes 会读注册表，而 HKEY_CLASSES_ROOT\.js 常被写成
text/plain —— 结果是 .js 以 text/plain 返回。

`<script src>` 对此是宽容的（没有 nosniff 就照跑），所以页面一直"看着正常"；
但 Worker 里的 importScripts() **强制要求 JavaScript MIME**，否则直接抛
"NetworkError: The script ... failed to load"。
表现极具迷惑性：Worker 建得出来、主线程完全流畅，但配准一个进度都不回报，
按钮一直停在「运行 ICP」——整条线程静默失效。"""

MIME_FIX = {
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.map': 'application/json',
}


def guess_ctype(full):
    """先查硬编码表，再退回 mimetypes（其余类型注册表不影响）"""
    ext = os.path.splitext(full)[1].lower()
    if ext in MIME_FIX:
        return MIME_FIX[ext]
    return mimetypes.guess_type(full)[0] or 'application/octet-stream'


class Handler(opt.Handler):
    server_version = 'ViewerServe/1.0'

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == '' or path == '/':
            path = '/index.html'

        if path.startswith('/health'):
            self._json(200, {
                'ok': True,
                'exe': opt.EXE,
                'exists': os.path.isfile(opt.EXE),
                'data': opt.DATA_ROOT,
                'search': opt.SEARCH_ROOTS,
                'port': PORT,
                'mode': 'same-origin',
                'log': opt.LOG_PATH,
                'lastError': opt.LAST_ERROR
            })
            return

        if path.startswith('/file'):
            return self._serve_file()

        if path.startswith('/log') or path.startswith('/locate'):
            return opt.Handler.do_GET(self)

        self._serve_static(path)

    def _serve_file(self):
        """按绝对路径回读数据文件（供「载入历史」重开用）。

        只接受本机请求，路径必须落在 opt.SEARCH_ROOTS 之内；
        以流式方式发出，避免把几百 MB 的文件整体读进内存。
        """
        if self.client_address[0] not in ('127.0.0.1', '::1'):
            self._json(403, {'error': 'only localhost'})
            return

        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        raw = urllib.parse.unquote((q.get('path') or [''])[0])
        full = opt.servable_path(raw)
        if not full:
            self._json(404, {'error': 'not allowed or not found', 'path': raw})
            return

        ctype = guess_ctype(full)
        try:
            size = os.path.getsize(full)
        except OSError:
            self._json(500, {'error': 'stat failed'})
            return

        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(size))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        try:
            with open(full, 'rb') as fh:
                shutil.copyfileobj(fh, self.wfile, 1 << 20)
        except Exception:
            pass        # 客户端中途取消

    def _serve_static(self, path):
        rel = urllib.parse.unquote(path).lstrip('/')
        full = os.path.normpath(os.path.join(ROOT, rel))
        if not full.startswith(ROOT) or not os.path.isfile(full):
            self.send_error(404, 'Not Found')
            return

        try:
            with open(full, 'rb') as fh:
                data = fh.read()
        except Exception:
            self.send_error(500, 'Read error')
            return

        ctype = guess_ctype(full)
        if ctype.startswith('text/') or ctype in ('application/javascript',
                                                  'application/json'):
            ctype += '; charset=utf-8'

        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.write(data)


def main():
    url = 'http://127.0.0.1:%d/index.html' % PORT
    opt.log('==== viewer + bridge (same origin) ====')
    opt.log('  url : %s' % url)
    opt.log('  exe : %s  exists=%s' % (opt.EXE, os.path.isfile(opt.EXE)))
    opt.log('  data: %s' % opt.DATA_ROOT)
    print('Viewer + optimize bridge -> %s' % url)
    if os.environ.get('VIEWER_NOBROWSER') != '1':
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()


if __name__ == '__main__':
    main()
