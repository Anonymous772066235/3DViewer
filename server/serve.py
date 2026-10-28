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
import sys
import threading
import urllib.parse
import webbrowser
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)   # bridge.py 与本文件同目录

import bridge as opt   # noqa: E402  （服务端模块统一在 server/ 下）

PORT = int(os.environ.get('VIEWER_PORT', '8765'))
ROOT = os.path.dirname(HERE)   # 静态资源根 = viewer3d/


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

        if path.startswith('/log') or path.startswith('/locate'):
            return opt.Handler.do_GET(self)

        self._serve_static(path)

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

        ctype = mimetypes.guess_type(full)[0] or 'application/octet-stream'
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
