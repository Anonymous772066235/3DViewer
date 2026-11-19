/* [W·后台] worker_topo.js — 拓扑（边 / 边界 / 面法向）
 * 协议：{id, positions, remap, triCount} → {edges, boundary, faces, ...}
 * 依赖：无（纯计算）
 */
(function ()
{
    'use strict';

    self.onmessage = function (ev)
    {
        var m = ev.data;
        var pos = m.positions;
        var remap = m.remap;
        var tri = m.triCount | 0;
        var LIM = 16777216;                       // 2^24

        var edgeMap = new Map();                  // key -> 边序号
        var eA = [], eB = [], eUse = [];          // 原始顶点索引 + 使用次数
        var ne = 0;

        var faces = new Float32Array(tri * 6);
        var nf = 0;
        var sumEdge = 0, cntEdge = 0;
        var probe = Math.max(1, Math.floor(tri / 512));

        function addEdge(va, vb, ua, ub)
        {
            if (ua === ub) { return; }
            var key = ua < ub ? ua * LIM + ub : ub * LIM + ua;
            var idx = edgeMap.get(key);
            if (idx === undefined)
            {
                edgeMap.set(key, ne);
                eA.push(va); eB.push(vb); eUse.push(1);
                ne++;
                return;
            }
            if (eUse[idx] < 255) { eUse[idx]++; }
        }

        for (var i = 0; i < tri; i++)
        {
            var o = i * 9;
            var x0 = pos[o], y0 = pos[o + 1], z0 = pos[o + 2];
            var x1 = pos[o + 3], y1 = pos[o + 4], z1 = pos[o + 5];
            var x2 = pos[o + 6], y2 = pos[o + 7], z2 = pos[o + 8];

            var ax = x1 - x0, ay = y1 - y0, az = z1 - z0;
            var bx = x2 - x0, by = y2 - y0, bz = z2 - z0;
            var nx = ay * bz - az * by;
            var ny = az * bx - ax * bz;
            var nz = ax * by - ay * bx;
            var nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (nl >= 1e-12)
            {
                nx /= nl; ny /= nl; nz /= nl;
                var q = nf * 6;
                faces[q] = (x0 + x1 + x2) / 3;
                faces[q + 1] = (y0 + y1 + y2) / 3;
                faces[q + 2] = (z0 + z1 + z2) / 3;
                faces[q + 3] = nx; faces[q + 4] = ny; faces[q + 5] = nz;
                nf++;
            }

            if ((i % probe) === 0)
            {
                var ex = x2 - x1, ey = y2 - y1, ez = z2 - z1;
                sumEdge += (Math.sqrt(ax * ax + ay * ay + az * az) +
                            Math.sqrt(bx * bx + by * by + bz * bz) +
                            Math.sqrt(ex * ex + ey * ey + ez * ez)) / 3;
                cntEdge++;
            }

            var v0 = i * 3, v1 = v0 + 1, v2 = v0 + 2;
            var u0 = remap ? remap[v0] : v0;
            var u1 = remap ? remap[v1] : v1;
            var u2 = remap ? remap[v2] : v2;
            addEdge(v0, v1, u0, u1);
            addEdge(v1, v2, u1, u2);
            addEdge(v2, v0, u2, u0);
        }

        var edges = new Uint32Array(ne * 2);
        var bCount = 0;
        for (var k = 0; k < ne; k++)
        {
            edges[k * 2] = eA[k];
            edges[k * 2 + 1] = eB[k];
            if (eUse[k] === 1) { bCount++; }
        }
        var boundary = new Uint32Array(bCount * 2);
        var bw = 0;
        for (var k2 = 0; k2 < ne; k2++)
        {
            if (eUse[k2] === 1)
            {
                boundary[bw++] = eA[k2];
                boundary[bw++] = eB[k2];
            }
        }
        eA.length = eB.length = eUse.length = 0;
        edgeMap.clear();

        var facesOut = faces.slice(0, nf * 6);
        self.postMessage({
            id: m.id,
            edges: edges,
            boundary: boundary,
            faces: facesOut,
            faceCount: nf,
            edgeCount: ne,
            boundaryEdges: bCount,
            avgEdge: cntEdge > 0 ? sumEdge / cntEdge : 1
        }, [edges.buffer, boundary.buffer, facesOut.buffer]);
    };
})();
