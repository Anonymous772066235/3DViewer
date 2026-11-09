/* KD-tree：三维点集的最近邻 / 半径查询
 *
 * 为 ICP 配准提供最近点查找。设计上刻意避开对象与闭包：
 *   - 点数据只引用不拷贝，索引用 Int32Array 存
 *   - 节点用多个平行类型化数组（dim / split / left / right / start / count）
 *   - 查询状态放在模块级变量，避免每次调用创建闭包
 *
 * 构建 O(n log n)，单次最近邻平均 O(log n)。
 */
(function (global)
{
    'use strict';

    global.MV = global.MV || {};

    var LEAF = 8;                 // 叶子最多容纳的点数

    function build(positions, count)
    {
        var n = count || Math.floor(positions.length / 3);
        if (!positions || n <= 0)
        {
            return null;
        }

        var pts = positions;
        var idx = new Int32Array(n);
        for (var i = 0; i < n; i++) { idx[i] = i; }

        // 完全平衡时叶子数可达 2^ceil(log2(n/LEAF))，节点数约为叶子的两倍，
        // 最坏接近 4n/LEAF；预留裕量避免越界（Int8Array 越界赋值是静默失败的）
        var maxNodes = Math.ceil(4 * n / LEAF) + 64;
        var nodeDim = new Int8Array(maxNodes);
        var nodeSplit = new Float32Array(maxNodes);
        var nodeLeft = new Int32Array(maxNodes);
        var nodeRight = new Int32Array(maxNodes);
        var nodeStart = new Int32Array(maxNodes);
        var nodeCount = new Int32Array(maxNodes);
        var nn = 0;

        function valOf(pi, dim)
        {
            return pts[pi * 3 + dim];
        }

        function swap(a, b)
        {
            var t = idx[a];
            idx[a] = idx[b];
            idx[b] = t;
        }

        /* 部分排序：让 idx[k] 落在排序后应在的位置（其左侧都不大于它，右侧都不小于它） */
        function nthElement(lo, hi, k, dim)
        {
            var i = lo;
            var j = hi - 1;

            while (i < j)
            {
                // 三数取中选 pivot，避免有序数据退化
                var m = (i + j) >> 1;
                var va = valOf(idx[i], dim);
                var vb = valOf(idx[m], dim);
                var vc = valOf(idx[j], dim);
                var pivot;
                if ((va <= vb && vb <= vc) || (vc <= vb && vb <= va)) { pivot = vb; }
                else if ((vb <= va && va <= vc) || (vc <= va && va <= vb)) { pivot = va; }
                else { pivot = vc; }

                var l = i;
                var r = j;
                while (l <= r)
                {
                    while (valOf(idx[l], dim) < pivot) { l++; }
                    while (valOf(idx[r], dim) > pivot) { r--; }
                    if (l <= r) { swap(l, r); l++; r--; }
                }

                if (k <= r) { j = r; }
                else if (k >= l) { i = l; }
                else { break; }
            }
        }

        function buildNode(lo, hi, depth)
        {
            var node = nn++;

            // 容量保护：剩余空间不足 3 个节点时强制收成叶子，绝不允许越界
            if (hi - lo <= LEAF || node + 2 >= maxNodes)
            {
                nodeDim[node] = -1;
                nodeStart[node] = lo;
                nodeCount[node] = hi - lo;
                return node;
            }

            // 按深度轮换分隔轴：坐标轴数量为 3，轮换足以避免单一轴反复切分
            var dim = depth % 3;
            var mid = (lo + hi) >> 1;

            nthElement(lo, hi, mid, dim);

            nodeDim[node] = dim;
            nodeSplit[node] = valOf(idx[mid], dim);
            nodeLeft[node] = buildNode(lo, mid, depth + 1);
            nodeRight[node] = buildNode(mid, hi, depth + 1);
            return node;
        }

        buildNode(0, n, 0);

        /* ---------------- 查询状态（模块级，避免闭包分配） ---------------- */

        var qx = 0, qy = 0, qz = 0;
        var bestIdx = -1, bestD2 = Infinity;
        var rad2 = 0;
        var radOut = [];

        function nearestRec(node)
        {
            var d = nodeDim[node];

            if (d < 0)
            {
                var s = nodeStart[node];
                var e = s + nodeCount[node];
                for (var i = s; i < e; i++)
                {
                    var pi = idx[i];
                    var p = pi * 3;
                    var dx = pts[p] - qx;
                    var dy = pts[p + 1] - qy;
                    var dz = pts[p + 2] - qz;
                    var d2 = dx * dx + dy * dy + dz * dz;
                    if (d2 < bestD2)
                    {
                        bestD2 = d2;
                        bestIdx = pi;
                    }
                }
                return;
            }

            var sv = nodeSplit[node];
            var diff = (d === 0 ? qx : (d === 1 ? qy : qz)) - sv;
            var L = nodeLeft[node];
            var R = nodeRight[node];

            if (diff < 0)
            {
                nearestRec(L);
                if (diff * diff < bestD2) { nearestRec(R); }
            }
            else
            {
                nearestRec(R);
                if (diff * diff < bestD2) { nearestRec(L); }
            }
        }

        function radiusRec(node)
        {
            var d = nodeDim[node];

            if (d < 0)
            {
                var s = nodeStart[node];
                var e = s + nodeCount[node];
                for (var i = s; i < e; i++)
                {
                    var pi = idx[i];
                    var p = pi * 3;
                    var dx = pts[p] - qx;
                    var dy = pts[p + 1] - qy;
                    var dz = pts[p + 2] - qz;
                    if (dx * dx + dy * dy + dz * dz <= rad2)
                    {
                        radOut.push(pi);
                    }
                }
                return;
            }

            var sv = nodeSplit[node];
            var diff = (d === 0 ? qx : (d === 1 ? qy : qz)) - sv;
            var L = nodeLeft[node];
            var R = nodeRight[node];

            if (diff < 0)
            {
                radiusRec(L);
                if (diff * diff <= rad2) { radiusRec(R); }
            }
            else
            {
                radiusRec(R);
                if (diff * diff <= rad2) { radiusRec(L); }
            }
        }

        return {
            /* 点数 */
            size: n,

            /* 返回 { index, dist2 }，点集为空时返回 null */
            nearest: function (x, y, z)
            {
                qx = x; qy = y; qz = z;
                bestIdx = -1;
                bestD2 = Infinity;
                nearestRec(0);
                return bestIdx >= 0 ? { index: bestIdx, dist2: bestD2 } : null;
            },

            /* 只返回索引，未命中返回 -1（ICP 热路径用，省去对象分配） */
            nearestIndex: function (x, y, z)
            {
                qx = x; qy = y; qz = z;
                bestIdx = -1;
                bestD2 = Infinity;
                nearestRec(0);
                return bestIdx;
            },

            /* 树的实际节点数，便于诊断容量是否够 */
            nodeCount: function () { return nn; },

            /* 半径内所有点索引（含边界） */
            radius: function (x, y, z, r)
            {
                qx = x; qy = y; qz = z;
                rad2 = r * r;
                radOut = [];
                radiusRec(0);
                return radOut;
            },

            /* 构建信息，便于诊断 */
            stats: function ()
            {
                var leaves = 0;
                for (var i = 0; i < nn; i++)
                {
                    if (nodeDim[i] < 0) { leaves++; }
                }
                return { points: n, nodes: nn, leaves: leaves, leafSize: LEAF };
            }
        };
    }

    global.MV.kdtree = { build: build };
})(window);
