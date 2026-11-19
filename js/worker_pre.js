/* [W·后台] worker_pre.js — 导入预处理 / 拾取索引
 * 协议：{cmd:'preprocess'|'pickgrid', ...}
 * 依赖：无（纯计算）
 */
(function ()
{
    'use strict';

    function analyzeMesh(positions)
    {
        var n = positions.length;
        var tri = Math.floor(n / 9);
        if (!tri) { return { vertCount: 0, bbox: null, uniqVerts: null, remap: null }; }

        var Q = 1e4;
        var seen = new Map();
        var uniq = new Float32Array(tri * 9);
        var remap = new Uint32Array(tri * 3);
        var m = 0;
        var mnx = Infinity, mny = Infinity, mnz = Infinity;
        var mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;

        for (var i = 0; i < tri * 9; i += 3)
        {
            var vi = i / 3;
            var x = positions[i], y = positions[i + 1], z = positions[i + 2];
            if (x < mnx) { mnx = x; }
            if (y < mny) { mny = y; }
            if (z < mnz) { mnz = z; }
            if (x > mxx) { mxx = x; }
            if (y > mxy) { mxy = y; }
            if (z > mxz) { mxz = z; }

            var kx = Math.round(x * Q), ky = Math.round(y * Q), kz = Math.round(z * Q);
            var key = (kx * 73856093) ^ (ky * 19349663) ^ (kz * 83492791);
            var hit = false, hitId = -1;
            var bucket = seen.get(key);
            if (bucket)
            {
                for (var b = 0; b < bucket.length; b++)
                {
                    var u = bucket[b];
                    if (uniq[u * 3] === x && uniq[u * 3 + 1] === y && uniq[u * 3 + 2] === z)
                    {
                        hit = true; hitId = u;
                        break;
                    }
                }
                if (!hit) { bucket.push(m); }
            }
            else { seen.set(key, [m]); }

            if (!hit)
            {
                uniq[m * 3] = x; uniq[m * 3 + 1] = y; uniq[m * 3 + 2] = z;
                remap[vi] = m;
                m++;
            }
            else { remap[vi] = hitId; }
        }
        return {
            vertCount: m,
            bbox: { min: [mnx, mny, mnz], max: [mxx, mxy, mxz] },
            uniqVerts: uniq.slice(0, m * 3),
            remap: remap
        };
    }

    function buildIndexed(positions, weld, an)
    {
        var tri = Math.floor(positions.length / 9);
        if (!weld)
        {
            var flat = new Float32Array(tri * 9);
            flat.set(positions.subarray(0, tri * 9));
            var eidx = new Uint32Array(tri * 3);
            for (var ei = 0; ei < tri * 3; ei++) { eidx[ei] = ei; }
            return { verts: flat, idx: eidx, vcount: tri * 3 };
        }
        return { verts: an.uniqVerts, idx: an.remap, vcount: an.vertCount };
    }

    function buildSpaceChunks(ix, tri)
    {
        var N = Math.max(3, Math.min(8, Math.round(Math.cbrt(tri / 4000)) || 3));
        var mnx = Infinity, mny = Infinity, mnz = Infinity;
        var mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
        var i;
        for (i = 0; i < ix.vcount; i++)
        {
            var vx = ix.verts[i * 3], vy = ix.verts[i * 3 + 1], vz = ix.verts[i * 3 + 2];
            if (vx < mnx) { mnx = vx; } if (vx > mxx) { mxx = vx; }
            if (vy < mny) { mny = vy; } if (vy > mxy) { mxy = vy; }
            if (vz < mnz) { mnz = vz; } if (vz > mxz) { mxz = vz; }
        }
        var sx = ((mxx - mnx) / N) || 1;
        var sy = ((mxy - mny) / N) || 1;
        var sz = ((mxz - mnz) / N) || 1;
        var grid = new Array(N * N * N);

        for (var t = 0; t < tri; t++)
        {
            var a0 = ix.idx[t * 3] * 3, a1 = ix.idx[t * 3 + 1] * 3, a2 = ix.idx[t * 3 + 2] * 3;
            var cx = (ix.verts[a0] + ix.verts[a1] + ix.verts[a2]) / 3;
            var cy = (ix.verts[a0 + 1] + ix.verts[a1 + 1] + ix.verts[a2 + 1]) / 3;
            var cz = (ix.verts[a0 + 2] + ix.verts[a1 + 2] + ix.verts[a2 + 2]) / 3;
            var gi = Math.min(N - 1, Math.max(0, Math.floor((cx - mnx) / sx)));
            var gj = Math.min(N - 1, Math.max(0, Math.floor((cy - mny) / sy)));
            var gk = Math.min(N - 1, Math.max(0, Math.floor((cz - mnz) / sz)));
            var key = (gi * N + gj) * N + gk;
            if (!grid[key]) { grid[key] = []; }
            grid[key].push(t);
        }

        var newIdx = new Uint32Array(tri * 3);
        var chunks = [];
        var w = 0;
        for (var ck = 0; ck < grid.length; ck++)
        {
            var list = grid[ck];
            if (!list) { continue; }
            var start = w;
            var cmnx = Infinity, cmny = Infinity, cmnz = Infinity;
            var cmxx = -Infinity, cmxy = -Infinity, cmxz = -Infinity;
            for (var q = 0; q < list.length; q++)
            {
                var o2 = list[q] * 3;
                for (var k = 0; k < 3; k++)
                {
                    var id = ix.idx[o2 + k];
                    newIdx[w++] = id;
                    var vo = id * 3;
                    var qx = ix.verts[vo], qy = ix.verts[vo + 1], qz = ix.verts[vo + 2];
                    if (qx < cmnx) { cmnx = qx; } if (qx > cmxx) { cmxx = qx; }
                    if (qy < cmny) { cmny = qy; } if (qy > cmxy) { cmxy = qy; }
                    if (qz < cmnz) { cmnz = qz; } if (qz > cmxz) { cmxz = qz; }
                }
            }
            chunks.push({
                count: w - start, offset: start * 4,
                mnx: cmnx, mny: cmny, mnz: cmnz,
                mxx: cmxx, mxy: cmxy, mxz: cmxz
            });
        }
        return { idx: newIdx, chunks: chunks, n: N };
    }

    /* 拾取空间网格：三角形 AABB 覆盖的格子登记三角形编号。
     * 与 ensurePickGrid 的实现一致；只在 PICK_GRID_MIN_TRIS 以上才值得建。 */
    function buildPickGrid(positions, tri, N)
    {
        var mnx = Infinity, mny = Infinity, mnz = Infinity;
        var mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
        for (var i = 0; i < tri * 9; i += 3)
        {
            var x = positions[i], y = positions[i + 1], z = positions[i + 2];
            if (x < mnx) { mnx = x; } if (x > mxx) { mxx = x; }
            if (y < mny) { mny = y; } if (y > mxy) { mxy = y; }
            if (z < mnz) { mnz = z; } if (z > mxz) { mxz = z; }
        }
        var sx = ((mxx - mnx) / N) || 1;
        var sy = ((mxy - mny) / N) || 1;
        var sz = ((mxz - mnz) / N) || 1;
        var cells = new Array(N * N * N);
        for (var t = 0; t < tri; t++)
        {
            var o = t * 9;
            var tx0 = Math.min(positions[o], positions[o + 3], positions[o + 6]);
            var tx1 = Math.max(positions[o], positions[o + 3], positions[o + 6]);
            var ty0 = Math.min(positions[o + 1], positions[o + 4], positions[o + 7]);
            var ty1 = Math.max(positions[o + 1], positions[o + 4], positions[o + 7]);
            var tz0 = Math.min(positions[o + 2], positions[o + 5], positions[o + 8]);
            var tz1 = Math.max(positions[o + 2], positions[o + 5], positions[o + 8]);
            var i0 = Math.min(N - 1, Math.max(0, Math.floor((tx0 - mnx) / sx)));
            var i1 = Math.min(N - 1, Math.max(0, Math.floor((tx1 - mnx) / sx)));
            var j0 = Math.min(N - 1, Math.max(0, Math.floor((ty0 - mny) / sy)));
            var j1 = Math.min(N - 1, Math.max(0, Math.floor((ty1 - mny) / sy)));
            var k0 = Math.min(N - 1, Math.max(0, Math.floor((tz0 - mnz) / sz)));
            var k1 = Math.min(N - 1, Math.max(0, Math.floor((tz1 - mnz) / sz)));
            for (var ci = i0; ci <= i1; ci++)
            {
                for (var cj = j0; cj <= j1; cj++)
                {
                    for (var ck = k0; ck <= k1; ck++)
                    {
                        var key = (ci * N + cj) * N + ck;
                        if (!cells[key]) { cells[key] = []; }
                        cells[key].push(t);
                    }
                }
            }
        }
        return { tri: tri, N: N, mnx: mnx, mny: mny, mnz: mnz,
                 sx: sx, sy: sy, sz: sz, cells: cells };
    }

    self.onmessage = function (ev)
    {
        var m = ev.data;

        /* 拾取网格命令：与导入预处理共用同一 Worker，不额外开线程 */
        if (m.cmd === 'pickgrid')
        {
            var pg = buildPickGrid(m.positions, m.triCount, m.N);
            self.postMessage({ id: m.id, cmd: 'pickgrid', grid: pg });
            return;
        }

        var pos = m.positions;
        var tri = Math.floor(pos.length / 9);
        var weld = !!m.weld;

        var an = analyzeMesh(pos);
        var ix = buildIndexed(pos, weld, an);
        var sc = buildSpaceChunks(ix, tri);

        /* 索引越界自检 */
        var maxId = ix.vcount - 1;
        var badIdx = 0;
        for (var i = 0; i < sc.idx.length; i++)
        {
            if (sc.idx[i] > maxId) { badIdx++; }
        }

        self.postMessage({
            id: m.id,
            uniqVerts: an.uniqVerts, remap: an.remap,
            vertCount: an.vertCount, bbox: an.bbox,
            verts: ix.verts, idx: ix.idx, vcount: ix.vcount,
            chunks: sc.chunks, orderedIdx: sc.idx,
            idxOk: badIdx === 0, badIdx: badIdx
        }, [
            an.uniqVerts.buffer, an.remap.buffer,
            ix.verts.buffer, ix.idx.buffer, sc.idx.buffer
        ]);
    };
})();
