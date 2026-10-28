# -*- coding: utf-8 -*-
"""
孔位优化桥接服务（仅监听 127.0.0.1）

浏览器无法直接执行本地 exe，这个服务负责：
  1. 接收前端上传的网格（可选 edge_pts.txt）
  2. 在系统临时目录里生成 run.cfg（S0_save = 0，不产生中间产物）
  3. 调用 HoleOptimize_cli.exe
  4. 读回最终 *_oh.obj，回传二进制
  5. 无论成功与否删除临时目录

接口：
  GET  /health     -> {"ok":true,"exe":"...","exists":true}
  POST /optimize   multipart: mesh=<file>, edge=<file，可选>
                   请求头 X-Mesh-Name: 原文件名（URL 编码）
                   响应 200 application/octet-stream，文件名在 X-Result-Name
                   失败返回 JSON {error}
"""
import glob
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------------- 终端输出统一 UTF-8（中文路径 / 中文日志不出现乱码或异常） ----------------
for _stream in (sys.stdout, sys.stderr):
    try:
        if hasattr(_stream, 'reconfigure'):
            _stream.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

# ---------------- 可按需修改 / 用环境变量覆盖 ----------------
PROJECT = os.environ.get('HOLEOPT_PROJECT', r'D:\Project\WBProject\OptimizeHole2D')


def resolve_exe():
    """优先环境变量；否则在 build 下依次找 Release / Debug 的 HoleOptimize_cli.exe"""
    env = os.environ.get('HOLEOPT_EXE')
    if env:
        return env
    build = os.path.join(PROJECT, 'HoleOptimize', 'build')
    for rel in (os.path.join('Release', 'HoleOptimize_cli.exe'),
                os.path.join('Debug', 'HoleOptimize_cli.exe')):
        path = os.path.join(build, rel)
        if os.path.isfile(path):
            return path
    # 都找不到时返回 Release 路径，便于错误提示定位
    return os.path.join(build, 'Release', 'HoleOptimize_cli.exe')


EXE = resolve_exe()
DATA_ROOT = os.environ.get('HOLEOPT_DATA',
                           os.path.join(PROJECT, r'HoleOptimize\data'))

# 反查绝对路径时搜索的根目录：数据目录 + 用户额外指定的目录（HOLEOPT_SEARCH，用 ; 分隔）
SEARCH_ROOTS = [DATA_ROOT]
for _extra in re.split(r'[;|]', os.environ.get('HOLEOPT_SEARCH', '')):
    _extra = _extra.strip().strip('"')
    if _extra and os.path.isdir(_extra) and _extra not in SEARCH_ROOTS:
        SEARCH_ROOTS.append(_extra)
PORT = int(os.environ.get('HOLEOPT_PORT', '8790'))
TIMEOUT = int(os.environ.get('HOLEOPT_TIMEOUT', '1800'))   # 秒

MESH_EXT = ('.stl', '.obj')

# ---------------- 日志（控制台 + bridge.log） ----------------
LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bridge.log')
LAST_ERROR = {'time': '', 'message': ''}


def log(msg):
    line = time.strftime('[%Y-%m-%d %H:%M:%S] ') + str(msg)
    try:
        print(line)
    except Exception:
        pass
    try:
        with io.open(LOG_PATH, 'a', encoding='utf-8') as fh:
            fh.write(line + '\n')
    except Exception:
        pass


def find_edge_by_name(mesh_name):
    """在 data 目录下按文件名找同名网格，取其同目录的 edge_pts.txt"""
    if not os.path.isdir(DATA_ROOT):
        return None
    pattern = os.path.join(DATA_ROOT, '**', mesh_name)
    for path in glob.iglob(pattern, recursive=True):
        cand = os.path.join(os.path.dirname(path), 'edge_pts.txt')
        if os.path.isfile(cand):
            return cand
    return None


def find_source_path(name, size=-1):
    """在搜索根（data + HOLEOPT_SEARCH）下定位文件，返回绝对路径。

    1) 先按「文件名 + 大小」精确匹配；
    2) 否则若同名文件全局只有一个，则返回它（兼容文件被另存/改动过大小）；
    3) 同名多个且大小都对不上 → 返回空，避免误判。
    """
    if not name:
        return ''

    exact = ''
    same_name = []
    for root in SEARCH_ROOTS:
        if not os.path.isdir(root):
            continue
        for path in glob.iglob(os.path.join(root, '**', name), recursive=True):
            if not os.path.isfile(path):
                continue
            ap = os.path.abspath(path)
            if ap in same_name:
                continue
            same_name.append(ap)
            if not exact and (size < 0 or os.path.getsize(ap) == size):
                exact = ap

    if exact:
        return exact
    if len(same_name) == 1:
        return same_name[0]
    return ''


def sanitize_name(name, ext):
    """保留中文与常用字符，仅替换 Windows 文件名非法字符"""
    base = os.path.splitext(os.path.basename(name or ''))[0]
    base = re.sub(r'[\\/:*?"<>|\r\n\t]', '_', base).strip(' .')
    return (base or 'input') + ext


def decode_bytes(raw):
    """CLI 输出可能是 UTF-8（chcp 65001）或 GBK（默认代码页），依次尝试"""
    if not raw:
        return ''
    if isinstance(raw, str):
        return raw
    for enc in ('utf-8', 'gbk', 'mbcs'):
        try:
            return raw.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode('utf-8', 'replace')


def parse_multipart(body, content_type):
    """极简 multipart/form-data 解析：{field: bytes}"""
    m = re.search(r'boundary=([^;]+)', content_type or '')
    if not m:
        return {}
    boundary = m.group(1).strip().strip('"').encode()
    out = {}
    for chunk in body.split(b'--' + boundary):
        if b'Content-Disposition' not in chunk:
            continue
        head, sep, data = chunk.partition(b'\r\n\r\n')
        if not sep:
            continue
        nm = re.search(rb'name="([^"]+)"', head)
        if not nm:
            continue
        # 每个 part 末尾恰好有一个 CRLF，只去掉一次，避免破坏二进制
        if data.endswith(b'\r\n'):
            data = data[:-2]
        out[nm.group(1).decode('utf-8', 'ignore')] = data
    return out


def run_pipeline(mesh_bytes, mesh_name, edge_bytes):
    """返回 (obj_bytes, 输出文件名, cli 日志)"""
    if not os.path.isfile(EXE):
        raise RuntimeError('找不到 HoleOptimize_cli.exe：' + EXE +
                           '（请先构建：cmake --build build --config Release，'
                           '或用环境变量 HOLEOPT_EXE 指定）')

    work = tempfile.mkdtemp(prefix='holeopt_')
    try:
        ext = os.path.splitext(mesh_name)[1].lower()
        if ext not in MESH_EXT:
            ext = '.stl'

        if not edge_bytes:
            found = find_edge_by_name(mesh_name)
            if not found:
                raise RuntimeError(
                    '缺少边界点云 edge_pts.txt：请把网格与 edge_pts.txt 一起导入，'
                    '或把网格放到 HoleOptimize/data/<数据集>/ 下（同目录需有 edge_pts.txt）')
            with open(found, 'rb') as fh:
                edge_bytes = fh.read()
            log('  edge -> 自动匹配 %s (%d bytes)' % (found, len(edge_bytes)))
        else:
            log('  edge -> 前端上传 (%d bytes)' % len(edge_bytes))

        edge_path = os.path.join(work, 'edge_pts.txt')
        with open(edge_path, 'wb') as fh:
            fh.write(edge_bytes)

        # 第一轮保留原始文件名（支持中文）；若失败且含非 ASCII，再用 ASCII 名重试一次
        keep = sanitize_name(mesh_name, ext)
        candidates = [keep]
        if any(ord(ch) > 127 for ch in keep):
            candidates.append('input' + ext)

        last_rc = -1
        last_log = ''
        for ci in range(len(candidates)):
            fname = candidates[ci]
            mesh_path = os.path.join(work, fname)
            with open(mesh_path, 'wb') as fh:
                fh.write(mesh_bytes)

            # 每轮独立输出目录，避免上一轮残留下误判成功
            out_dir = os.path.join(work, 'out%d' % (ci + 1))
            os.makedirs(out_dir, exist_ok=True)

            cfg_path = os.path.join(work, 'run%d.cfg' % (ci + 1))
            with io.open(cfg_path, 'w', encoding='utf-8', newline='\n') as fh:
                fh.write('S0_in = ' + edge_path + '\n')
                fh.write('S0_mesh = ' + mesh_path + '\n')
                fh.write('S0_out = ' + out_dir + '\n')
                fh.write('S0_save = 0\n')          # 关键：不生成中间产物
                fh.write('S0_log = 1\n')

            log('  run  -> #%d mesh=%s  (原名 %s)' % (ci + 1, fname, mesh_name))
            log('  exe  -> %s' % EXE)
            log('  cfg  -> %s' % cfg_path)

            t0 = time.time()
            proc = subprocess.run([EXE, cfg_path],
                                  cwd=os.path.dirname(EXE),
                                  capture_output=True,
                                  timeout=TIMEOUT)

            cli_log = decode_bytes(proc.stdout) + decode_bytes(proc.stderr)
            last_rc = proc.returncode
            last_log = cli_log

            results = sorted(glob.glob(os.path.join(out_dir, '*_oh*.obj')),
                             key=os.path.getmtime)
            log('  cli  -> exit=%s  %.1fs  outputs=%d' %
                (proc.returncode, time.time() - t0, len(results)))
            for line in cli_log.splitlines()[-40:]:
                log('  | ' + line)

            if proc.returncode == 0 and results:
                with open(results[-1], 'rb') as fh:
                    data = fh.read()
                base = os.path.splitext(os.path.basename(mesh_name))[0] or 'result'
                if ci > 0:
                    log('  note -> 中文文件名运行失败，已改用 ASCII 名重试成功')
                return data, base + '_oh.obj', cli_log

        raise RuntimeError('优化失败（exit=%s）\n%s' % (last_rc, last_log[-4000:]))
    finally:
        # 幂等清理：临时目录（含所有中间产物）全部删除
        shutil.rmtree(work, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    server_version = 'HoleOptBridge/1.0'
    protocol_version = 'HTTP/1.1'

    # ---------------- 工具 ----------------
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        # 允许前端读取自定义响应头（结果文件名）
        self.send_header('Access-Control-Expose-Headers', 'X-Result-Name')

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    # ---------------- 路由 ----------------
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        if self.path.startswith('/health'):
            self._json(200, {
                'ok': True,
                'exe': EXE,
                'exists': os.path.isfile(EXE),
                'data': DATA_ROOT,
                'search': SEARCH_ROOTS,
                'port': PORT,
                'log': LOG_PATH,
                'lastError': LAST_ERROR
            })
        elif self.path.startswith('/log'):
            text = ''
            try:
                with io.open(LOG_PATH, 'r', encoding='utf-8', errors='ignore') as fh:
                    text = fh.read()[-8000:]
            except Exception:
                pass
            self._json(200, {'log': LOG_PATH, 'tail': text})
        elif self.path.startswith('/locate'):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            name = (q.get('name') or [''])[0]
            try:
                size = int((q.get('size') or ['-1'])[0])
            except ValueError:
                size = -1
            self._json(200, {'path': find_source_path(name, size)})
        else:
            self._json(404, {'error': 'not found'})

    def do_POST(self):
        if not self.path.startswith('/optimize'):
            self._json(404, {'error': 'not found'})
            return

        t0 = time.time()
        try:
            length = int(self.headers.get('Content-Length') or 0)
            body = self.rfile.read(length)
            files = parse_multipart(body, self.headers.get('Content-Type'))

            mesh = files.get('mesh')
            if not mesh:
                raise RuntimeError('缺少 mesh 文件（前端未附上网格）')

            raw_name = self.headers.get('X-Mesh-Name', 'input.stl')
            mesh_name = urllib.parse.unquote(raw_name) or 'input.stl'
            log('POST /optimize  mesh=%s (%d bytes)  edge=%s' %
                (mesh_name, len(mesh), 'yes' if files.get('edge') else 'no'))

            data, out_name, cli_log = run_pipeline(mesh, mesh_name, files.get('edge'))

            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('X-Result-Name', urllib.parse.quote(out_name))
            self._cors()
            self.end_headers()
            self.wfile.write(data)

            LAST_ERROR['time'] = ''
            LAST_ERROR['message'] = ''
            log('OK   %s -> %s  (%.1fs, %d bytes)' %
                (mesh_name, out_name, time.time() - t0, len(data)))
        except Exception as ex:
            tb = traceback.format_exc()
            LAST_ERROR['time'] = time.strftime('%Y-%m-%d %H:%M:%S')
            LAST_ERROR['message'] = str(ex)
            log('FAIL %s\n%s' % (str(ex), tb))
            self._json(500, {
                'error': str(ex),
                'trace': tb[-4000:],
                'log': LOG_PATH
            })

    def log_message(self, fmt, *args):
        # 默认实现里 requestline 是 URL 编码的（%E5%AD%94...），这里还原成中文再输出
        try:
            msg = fmt % args
        except Exception:
            msg = str(args)
        try:
            msg = urllib.parse.unquote(msg)
        except Exception:
            pass
        log('[http] ' + msg)


if __name__ == '__main__':
    log('==== bridge start ====')
    log('  url : http://127.0.0.1:%d' % PORT)
    log('  exe : %s  exists=%s' % (EXE, os.path.isfile(EXE)))
    log('  data: %s' % DATA_ROOT)
    log('  log : %s' % LOG_PATH)
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
