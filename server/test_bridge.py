# -*- coding: utf-8 -*-
"""
bridge 自检脚本（不经过浏览器，直接验证“上传网格 -> CLI -> 返回 OBJ”链路）

用法：
    python test_bridge.py                     # 自动挑 data 下最小的 .stl
    python test_bridge.py "D:\\path\\a.stl"    # 指定网格
环境变量：同 bridge.py（HOLEOPT_PORT 等）
"""
import os
import sys
import time
import uuid
import glob
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.environ.get('HOLEOPT_PROJECT', r'D:\Project\WBProject\OptimizeHole2D')
DATA = os.environ.get('HOLEOPT_DATA', os.path.join(PROJECT, 'HoleOptimize', 'data'))
PORT = int(os.environ.get('HOLEOPT_PORT', '8790'))
URL = 'http://127.0.0.1:%d/optimize' % PORT


def pick_mesh():
    if len(sys.argv) > 1:
        return sys.argv[1]
    cands = glob.glob(os.path.join(DATA, '**', '*.stl'), recursive=True)
    cands.sort(key=os.path.getsize)
    for path in cands:
        if os.path.isfile(os.path.join(os.path.dirname(path), 'edge_pts.txt')):
            return path
    raise SystemExit('data 下没有同时包含 .stl 与 edge_pts.txt 的数据集')


def main():
    mesh = pick_mesh()
    name = os.path.basename(mesh)
    with open(mesh, 'rb') as fh:
        payload = fh.read()
    print('mesh :', mesh, '(%d bytes)' % len(payload))

    boundary = uuid.uuid4().hex
    head = ('--%s\r\nContent-Disposition: form-data; name="mesh"; filename="input.stl"\r\n'
            'Content-Type: application/octet-stream\r\n\r\n' % boundary).encode()
    tail = ('\r\n--%s--\r\n' % boundary).encode()

    req = urllib.request.Request(URL, data=head + payload + tail, method='POST')
    req.add_header('Content-Type', 'multipart/form-data; boundary=' + boundary)
    req.add_header('X-Mesh-Name', urllib.parse.quote(name))

    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=1800) as resp:
            data = resp.read()
            out = urllib.parse.unquote(resp.headers.get('X-Result-Name') or '')
            dst = os.path.join(HERE, '_selfcheck_result.obj')
            with open(dst, 'wb') as fh:
                fh.write(data)
            print('status:', resp.status, 'bytes:', len(data), 'name:', out)
            print('elapsed: %.1fs' % (time.time() - t0))
            print('saved :', dst)
    except urllib.error.HTTPError as ex:
        print('HTTP', ex.code)
        print(ex.read().decode('utf-8', 'ignore')[:2000])
        sys.exit(1)


if __name__ == '__main__':
    main()
