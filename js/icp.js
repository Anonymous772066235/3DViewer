/* Symmetric ICP
 *
 * 参考：Szymon Rusinkiewicz, "A Symmetric Objective Function for ICP"
 *       (SIGGRAPH 2019)；实现思路对应 trimesh2 的 ICP.cpp / SymmetricICPEstep。
 *
 * 与经典 ICP 的差别在目标函数：对每个对应点，残差同时投影到
 * **目标法向 n** 和**源法向 m** 两个方向 ——
 *
 *     r1 = (p − q)·n
 *     r2 = (p − q)·m
 *
 * 这样既不依赖单侧法向的朝向，也能让两者在部分重叠、法向有噪声时互相约束。
 *
 * 线性化：令 p' = p + ω×p + v（小角度），
 *     (ω×p)·n = ω·(p×n)
 * 于是每个点贡献两行
 *     [ (p×n)ᵀ , nᵀ ] · [ω; v] = −(p − q)·n
 *     [ (p×m)ᵀ , mᵀ ] · [ω; v] = −(p − q)·m
 * 累加成 6×6 正规方程，Cholesky 求解，更新 R ← exp([ω]×)·R，t ← exp([ω]×)·t + v。
 *
 * 两侧都没有法向时退化为点到点（每点 3 行）。
 *
 * 提供两个入口：
 *   symmetric()     一次性跑完（同步，适合脚本/自测）
 *   createSolver()  按轮驱动（step()），供界面分帧执行，避免长时间阻塞主线程
 */
(function (global)
{
    'use strict';

    global.MV = global.MV || {};

    /* ---------------- 线性代数小工具 ---------------- */

    /* 6×6 对称正定系统，Cholesky 分解；非正定返回 null */
    function solve6(A, b)
    {
        var L = new Float64Array(36);
        var i, j, k, sum;

        for (i = 0; i < 6; i++)
        {
            for (j = 0; j <= i; j++)
            {
                sum = A[i * 6 + j];
                for (k = 0; k < j; k++) { sum -= L[i * 6 + k] * L[j * 6 + k]; }

                if (i === j)
                {
                    if (sum <= 0) { return null; }
                    L[i * 6 + j] = Math.sqrt(sum);
                }
                else
                {
                    L[i * 6 + j] = sum / L[j * 6 + j];
                }
            }
        }

        // L·y = b
        var y = new Float64Array(6);
        for (i = 0; i < 6; i++)
        {
            sum = b[i];
            for (k = 0; k < i; k++) { sum -= L[i * 6 + k] * y[k]; }
            y[i] = sum / L[i * 6 + i];
        }

        // Lᵀ·x = y
        var x = new Float64Array(6);
        for (i = 5; i >= 0; i--)
        {
            sum = y[i];
            for (k = i + 1; k < 6; k++) { sum -= L[k * 6 + i] * x[k]; }
            x[i] = sum / L[i * 6 + i];
        }
        return x;
    }

    /* 旋转向量 → 旋转矩阵（Rodrigues），返回 3×3 行主序 */
    function expSO3(wx, wy, wz, out)
    {
        var th2 = wx * wx + wy * wy + wz * wz;

        if (th2 < 1e-24)
        {
            out[0] = 1;      out[1] = -wz;   out[2] = wy;
            out[3] = wz;     out[4] = 1;     out[5] = -wx;
            out[6] = -wy;    out[7] = wx;    out[8] = 1;
            return out;
        }

        var th = Math.sqrt(th2);
        var kx = wx / th, ky = wy / th, kz = wz / th;
        var c = Math.cos(th), s = Math.sin(th), v = 1 - c;

        out[0] = c + kx * kx * v;        out[1] = kx * ky * v - kz * s;   out[2] = kx * kz * v + ky * s;
        out[3] = ky * kx * v + kz * s;   out[4] = c + ky * ky * v;        out[5] = ky * kz * v - kx * s;
        out[6] = kz * kx * v - ky * s;   out[7] = kz * ky * v + kx * s;   out[8] = c + kz * kz * v;
        return out;
    }

    /* 3×3 相乘 a·b（行主序） */
    function mul3(a, b, out)
    {
        for (var r = 0; r < 3; r++)
        {
            for (var c = 0; c < 3; c++)
            {
                out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
            }
        }
        return out;
    }

    /* 累加一行到正规方程 A += row·rowᵀ, b += row·rhs
     * 必须填满整个 6×6：solve6 的 Cholesky 会同时读上下三角，
     * 只填上三角等于解错方程组（曾导致 ICP 每轮残差指数级放大）。 */
    function addRow6(A, b, c0, c1, c2, n0, n1, n2, rhs)
    {
        var row = [c0, c1, c2, n0, n1, n2];
        var i, j, ri, rj;

        for (i = 0; i < 6; i++)
        {
            ri = row[i];
            for (j = 0; j < 6; j++)
            {
                rj = row[j];
                A[i * 6 + j] += ri * rj;
            }
            b[i] += ri * rhs;
        }
    }

    /* ---------------- 顶点法向 ---------------- */

    /* 由网格三角形累积顶点法向；remap 为三角形顶点索引（每三角形 3 个），可省略 */
    function computeVertexNormals(positions, remap, vertCount)
    {
        var nTri = Math.floor(positions.length / 9);
        var nv = vertCount || (remap ? (remap.length / 3) : Math.floor(positions.length / 3));

        if (remap && vertCount)
        {
            nv = vertCount;
        }
        else if (remap)
        {
            var mx = 0;
            for (var r = 0; r < remap.length; r++) { if (remap[r] > mx) { mx = remap[r]; } }
            nv = mx + 1;
        }

        var nrm = new Float32Array(nv * 3);

        for (var t = 0; t < nTri; t++)
        {
            var o = t * 9;
            var ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
            var bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
            var cx = positions[o + 6], cy = positions[o + 7], cz = positions[o + 8];

            var e1x = bx - ax, e1y = by - ay, e1z = bz - az;
            var e2x = cx - ax, e2y = cy - ay, e2z = cz - az;

            var nx = e1y * e2z - e1z * e2y;
            var ny = e1z * e2x - e1x * e2z;
            var nz = e1x * e2y - e1y * e2x;

            var i0, i1, i2;
            if (remap)
            {
                i0 = remap[t * 3]; i1 = remap[t * 3 + 1]; i2 = remap[t * 3 + 2];
            }
            else
            {
                i0 = t * 3; i1 = t * 3 + 1; i2 = t * 3 + 2;
            }

            nrm[i0 * 3] += nx; nrm[i0 * 3 + 1] += ny; nrm[i0 * 3 + 2] += nz;
            nrm[i1 * 3] += nx; nrm[i1 * 3 + 1] += ny; nrm[i1 * 3 + 2] += nz;
            nrm[i2 * 3] += nx; nrm[i2 * 3 + 1] += ny; nrm[i2 * 3 + 2] += nz;
        }

        for (var i = 0; i < nrm.length; i += 3)
        {
            var len = Math.sqrt(nrm[i] * nrm[i] + nrm[i + 1] * nrm[i + 1] + nrm[i + 2] * nrm[i + 2]);
            if (len > 1e-12)
            {
                nrm[i] /= len;
                nrm[i + 1] /= len;
                nrm[i + 2] /= len;
            }
            else
            {
                nrm[i] = 0; nrm[i + 1] = 0; nrm[i + 2] = 0;
            }
        }

        return { normals: nrm, count: nv };
    }

    /* ---------------- 求解器（可按轮驱动） ---------------- */

    /* 行向量重正交（Gram-Schmidt）。
     * expSO3 每轮左乘会累积浮点误差，几十轮后 R 不再严格正交，
     * 于是 isRigidMat 判为"非刚体"，应用矩阵时被拒绝、数据保持原位 ——
     * 表现为 ICP 明明报了 RMS=0，模型却纹丝不动。 */
    function orthonormalize(R, out)
    {
        var r0x = R[0], r0y = R[1], r0z = R[2];
        var r1x = R[3], r1y = R[4], r1z = R[5];

        var n0 = Math.sqrt(r0x * r0x + r0y * r0y + r0z * r0z);
        if (!(n0 > 0)) { return false; }
        r0x /= n0; r0y /= n0; r0z /= n0;

        var d01 = r1x * r0x + r1y * r0y + r1z * r0z;
        r1x -= d01 * r0x; r1y -= d01 * r0y; r1z -= d01 * r0z;

        var n1 = Math.sqrt(r1x * r1x + r1y * r1y + r1z * r1z);
        if (!(n1 > 0)) { return false; }
        r1x /= n1; r1y /= n1; r1z /= n1;

        out[0] = r0x; out[1] = r0y; out[2] = r0z;
        out[3] = r1x; out[4] = r1y; out[5] = r1z;
        out[6] = r0y * r1z - r0z * r1y;
        out[7] = r0z * r1x - r0x * r1z;
        out[8] = r0x * r1y - r0y * r1x;
        return true;
    }

    function matOf(R, t)
    {
        // 先重正交：几十轮 expSO3 累积的浮点误差会让 R 偏离正交，
        // 上层 isRigidMat 校验不通过就不应用矩阵（表现为 RMS=0 但模型不动）
        var R2 = new Float64Array(9);
        if (orthonormalize(R, R2))
        {
            R = [R2[0], R2[1], R2[2], R2[3], R2[4], R2[5], R2[6], R2[7], R2[8]];
        }

        var m = new Float64Array(16);
        m[0] = R[0]; m[1] = R[1]; m[2] = R[2];   m[3] = t[0];
        m[4] = R[3]; m[5] = R[4]; m[6] = R[5];   m[7] = t[1];
        m[8] = R[6]; m[9] = R[7]; m[10] = R[8];  m[11] = t[2];
        m[12] = 0; m[13] = 0; m[14] = 0; m[15] = 1;
        return m;
    }

    /* opts 同 symmetric()；另支持 onIter(iters, rms, step) 返回 false 中止 */
    function createSolver(srcPos, srcNrm, dstPos, dstNrm, opts)
    {
        opts = opts || {};

        var maxIter = opts.maxIter || 50;
        var tol = opts.tol || 1e-7;
        var maxDist = opts.maxDist || 0;
        var normalThresh = (opts.normalThresh === undefined) ? 0.5 : opts.normalThresh;
        var onIter = opts.onIter || null;

        // 采样比例 0~1：1 表示不采样。兼容旧的整数 stride（1 表示全量）。
        var sampleRatio = 1;
        if (opts.sampleRatio !== undefined)
        {
            sampleRatio = Math.max(0.001, Math.min(1, opts.sampleRatio));
        }
        else if (opts.stride)
        {
            sampleRatio = Math.max(0.001, Math.min(1, 1 / opts.stride));
        }

        var kd = global.MV.kdtree.build(dstPos);
        if (!kd) { return null; }

        var nSrc = Math.floor(srcPos.length / 3);
        var nDst = Math.floor(dstPos.length / 3);
        if (!nSrc || !nDst) { return null; }

        var hasSrcN = !!srcNrm && srcNrm.length >= nSrc * 3;
        var hasDstN = !!dstNrm && dstNrm.length >= nDst * 3;

        var R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
        var t = [0, 0, 0];

        // 初值：允许从已有的粗配准（质心/PCA/上一次 ICP）出发，
        // 镜像类变体务必先把镜像作用到点集上，这里只接受刚体部分
        if (opts.initMat)
        {
            var im = opts.initMat;
            R = [im[0], im[1], im[2], im[4], im[5], im[6], im[8], im[9], im[10]];
            t = [im[3], im[7], im[11]];
        }

        /* 随机下采样：一次性抽取固定的索引集合，之后每轮都用同一批点。
         * 若每轮重新随机，RMS 会持续抖动、收敛判据失效。
         * 不采样时 idxList 保持 null，走零开销的全量遍历。 */
        var idxList = null;
        if (sampleRatio < 0.9999)
        {
            var want = Math.max(6, Math.round(nSrc * sampleRatio));

            if (want < nSrc)
            {
                var pool = new Int32Array(nSrc);
                for (var pi2 = 0; pi2 < nSrc; pi2++) { pool[pi2] = pi2; }

                // 部分 Fisher-Yates：只需要前 want 个
                for (var pi3 = 0; pi3 < want; pi3++)
                {
                    var pj = pi3 + Math.floor(Math.random() * (nSrc - pi3));
                    var pt = pool[pi3];
                    pool[pi3] = pool[pj];
                    pool[pj] = pt;
                }

                idxList = pool.subarray(0, want);
            }
        }

        var nSamples = idxList ? idxList.length : nSrc;

        var dR = new Float64Array(9);
        var tmp = new Float64Array(9);

        var iters = 0;
        var lastRms = Infinity;
        var used = 0;
        var done = false;

        /* 跑一轮，返回 { done, iters, rms, step, used } */
        function step()
        {
            if (done || iters >= maxIter)
            {
                done = true;
                return { done: true, iters: iters, rms: lastRms, step: 0, used: used };
            }

            /* 距离阈值随迭代递减（trim-ICP 的常见做法）：
             * 前 2/3 的迭代放宽到 3 倍，用于快速拉近；之后线性收紧回设定值，
             * 避免大阈值把错配带进最终解。
             * 初始偏差较大时，固定的小阈值会让几乎所有对应被丢弃，
             * 剩下的少量重叠点给出不唯一的解（实测偏移 50 会停在 15）。 */
            var curMaxDist = maxDist;
            if (maxDist > 0 && maxIter > 1)
            {
                var decay = 1 - Math.min(1, iters / (maxIter * 0.66));
                curMaxDist = maxDist * (1 + 2 * decay);
            }

            var A = new Float64Array(36);
            var b = new Float64Array(6);
            var cnt = 0;
            var sumSq = 0;

            for (var si = 0; si < nSamples; si++)
            {
                var i = idxList ? idxList[si] : si;
                var p0 = i * 3;
                var sx = srcPos[p0], sy = srcPos[p0 + 1], sz = srcPos[p0 + 2];

                var px = R[0] * sx + R[1] * sy + R[2] * sz + t[0];
                var py = R[3] * sx + R[4] * sy + R[5] * sz + t[1];
                var pz = R[6] * sx + R[7] * sy + R[8] * sz + t[2];

                var qi = kd.nearestIndex(px, py, pz);
                if (qi < 0) { continue; }

                var q0 = qi * 3;
                var qx = dstPos[q0], qy = dstPos[q0 + 1], qz = dstPos[q0 + 2];

                var dx = px - qx, dy = py - qy, dz = pz - qz;
                var d2 = dx * dx + dy * dy + dz * dz;

                if (curMaxDist > 0 && d2 > curMaxDist * curMaxDist) { continue; }

                var nx = 0, ny = 0, nz = 0;
                if (hasDstN) { nx = dstNrm[q0]; ny = dstNrm[q0 + 1]; nz = dstNrm[q0 + 2]; }

                var mx = 0, my = 0, mz = 0;
                if (hasSrcN) { mx = srcNrm[p0]; my = srcNrm[p0 + 1]; mz = srcNrm[p0 + 2]; }

                if (hasDstN && hasSrcN && (nx * mx + ny * my + nz * mz) < normalThresh)
                {
                    continue;
                }

                if (hasDstN || hasSrcN)
                {
                    if (hasDstN)
                    {
                        addRow6(A, b,
                            py * nz - pz * ny, pz * nx - px * nz, px * ny - py * nx,
                            nx, ny, nz,
                            -(dx * nx + dy * ny + dz * nz));
                        var rn = dx * nx + dy * ny + dz * nz;
                        sumSq += rn * rn;
                        cnt++;
                    }
                    if (hasSrcN)
                    {
                        addRow6(A, b,
                            py * mz - pz * my, pz * mx - px * mz, px * my - py * mx,
                            mx, my, mz,
                            -(dx * mx + dy * my + dz * mz));
                        if (!hasDstN)
                        {
                            var rm = dx * mx + dy * my + dz * mz;
                            sumSq += rm * rm;
                            cnt++;
                        }
                    }
                }
                else
                {
                    addRow6(A, b, 0, pz, -py, 1, 0, 0, -dx);
                    addRow6(A, b, -pz, 0, px, 0, 1, 0, -dy);
                    addRow6(A, b, py, -px, 0, 0, 0, 1, -dz);
                    sumSq += d2;
                    cnt++;
                }
            }

            if (cnt < 6)
            {
                done = true;
                return { done: true, iters: iters, rms: lastRms, step: 0, used: used };
            }

            var rms = Math.sqrt(sumSq / cnt);
            used = cnt;

            var sol = solve6(A, b);
            if (!sol)
            {
                done = true;
                return { done: true, iters: iters, rms: rms, step: 0, used: used };
            }

            expSO3(sol[0], sol[1], sol[2], dR);
            mul3(dR, R, tmp);
            R = [tmp[0], tmp[1], tmp[2], tmp[3], tmp[4], tmp[5], tmp[6], tmp[7], tmp[8]];

            var ntx = dR[0] * t[0] + dR[1] * t[1] + dR[2] * t[2] + sol[3];
            var nty = dR[3] * t[0] + dR[4] * t[1] + dR[5] * t[2] + sol[4];
            var ntz = dR[6] * t[0] + dR[7] * t[1] + dR[8] * t[2] + sol[5];
            t = [ntx, nty, ntz];

            var stepLen = Math.sqrt(sol[0] * sol[0] + sol[1] * sol[1] + sol[2] * sol[2])
                        + Math.sqrt(sol[3] * sol[3] + sol[4] * sol[4] + sol[5] * sol[5]);

            iters++;

            // 相对判据：不同尺度的模型用同一个 tol 才有一致的收敛行为。
            // 绝对阈值会导致大模型永远达不到、每次都跑满 maxIter。
            var converged = (Math.abs(lastRms - rms) < tol * (1 + rms)) || (stepLen < 1e-9);
            lastRms = rms;

            if (onIter && onIter(iters, rms, stepLen) === false) { done = true; }
            if (converged) { done = true; }

            return { done: done, iters: iters, rms: rms, step: stepLen, used: cnt, converged: converged };
        }

        return {
            step: step,
            cancel: function () { done = true; },
            isDone: function () { return done; },
            result: function ()
            {
                return {
                    mat: matOf(R, t),
                    rms: lastRms,
                    iters: iters,
                    used: used,
                    hasNormals: hasSrcN || hasDstN
                };
            }
        };
    }

    /* 一次性跑完（同步） */
    function symmetric(srcPos, srcNrm, dstPos, dstNrm, opts)
    {
        var solver = createSolver(srcPos, srcNrm, dstPos, dstNrm, opts);
        if (!solver) { return null; }

        var guard = 0;
        while (!solver.isDone() && guard++ < 10000)
        {
            solver.step();
        }
        return solver.result();
    }

    /* ---------------- PCA 主轴 ---------------- */

    /* 3×3 对称矩阵 Jacobi 特征分解，返回按特征值降序的 (特征值, 主轴) */
    function jacobi3(Ain)
    {
        var A = [
            [Ain[0][0], Ain[0][1], Ain[0][2]],
            [Ain[1][0], Ain[1][1], Ain[1][2]],
            [Ain[2][0], Ain[2][1], Ain[2][2]]
        ];
        var V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        var p, q, k;

        for (var sweep = 0; sweep < 60; sweep++)
        {
            var off = A[0][1] * A[0][1] + A[0][2] * A[0][2] + A[1][2] * A[1][2];
            if (off < 1e-26) { break; }

            for (p = 0; p < 2; p++)
            {
                for (q = p + 1; q < 3; q++)
                {
                    if (Math.abs(A[p][q]) < 1e-20) { continue; }

                    var theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
                    var t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                    var c = 1 / Math.sqrt(t * t + 1);
                    var sn = t * c;

                    for (k = 0; k < 3; k++)
                    {
                        var akp = A[k][p], akq = A[k][q];
                        A[k][p] = c * akp - sn * akq;
                        A[k][q] = sn * akp + c * akq;
                    }
                    for (k = 0; k < 3; k++)
                    {
                        var apk = A[p][k], aqk = A[q][k];
                        A[p][k] = c * apk - sn * aqk;
                        A[q][k] = sn * apk + c * aqk;
                    }
                    for (k = 0; k < 3; k++)
                    {
                        var vkp = V[k][p], vkq = V[k][q];
                        V[k][p] = c * vkp - sn * vkq;
                        V[k][q] = sn * vkp + c * vkq;
                    }
                }
            }
        }

        var order = [0, 1, 2];
        order.sort(function (a, b) { return A[b][b] - A[a][a]; });

        var values = [];
        var axes = [];
        for (var i = 0; i < 3; i++)
        {
            var idx = order[i];
            values.push(A[idx][idx]);
            axes.push([V[0][idx], V[1][idx], V[2][idx]]);
        }

        // 确定性符号：每个主轴让绝对值最大的分量为正，
        // 两边用同一约定后矩阵才可比（简并时仍需外层枚举兜底）
        for (i = 0; i < 3; i++)
        {
            var a = axes[i];
            var best = 0;
            if (Math.abs(a[1]) > Math.abs(a[best])) { best = 1; }
            if (Math.abs(a[2]) > Math.abs(a[best])) { best = 2; }
            if (a[best] < 0)
            {
                a[0] = -a[0]; a[1] = -a[1]; a[2] = -a[2];
            }
        }

        return { values: values, axes: axes };
    }

    /* 点集的质心与主轴；stride 用于大点集抽样 */
    function pcaOf(positions, count, stride)
    {
        var n = count || Math.floor(positions.length / 3);
        var st = Math.max(1, stride || 1);

        var cx = 0, cy = 0, cz = 0, m = 0;
        var i;
        for (i = 0; i < n; i += st)
        {
            cx += positions[i * 3];
            cy += positions[i * 3 + 1];
            cz += positions[i * 3 + 2];
            m++;
        }
        if (!m) { return null; }
        cx /= m; cy /= m; cz /= m;

        var xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
        for (i = 0; i < n; i += st)
        {
            var dx = positions[i * 3] - cx;
            var dy = positions[i * 3 + 1] - cy;
            var dz = positions[i * 3 + 2] - cz;
            xx += dx * dx; xy += dx * dy; xz += dx * dz;
            yy += dy * dy; yz += dy * dz; zz += dz * dz;
        }

        var cov = [[xx / m, xy / m, xz / m], [xy / m, yy / m, yz / m], [xz / m, yz / m, zz / m]];
        var eig = jacobi3(cov);

        return { center: [cx, cy, cz], axes: eig.axes, values: eig.values };
    }


    /* ---------------- 自动粗配准（Super4PCS 的简化实现） ----------------
     *
     * 论文做法：从源点集取共面 4 点，用 LCP（最大公共点集）索引在目标中
     * 快速找出与此 4 点全等的所有 4 点组，再按最优子集枚举 + RANSAC 打分。
     *
     * 这里做了三处简化，换来实现量与内存可控：
     *   1. 不做 LCP 索引，改在抽样后的目标点集上按"逐级半径查询"扩张；
     *   2. 不做最优子集枚举，每级只保留少量候选（宽基线本身已给出较强约束）；
     *   3. 打分用固定抽样点的内点率，而不是全量 LCP。
     *
     * 对"两个姿态差异很大、PCA 主轴又区分不开"的工件，这一步能把 ICP
     * 拉进收敛域，剩下的精度交给后面的对称 ICP。
     */

    /* 4×4 对称矩阵的最大特征向量（Jacobi 旋转），用于 Horn 四元数求解 */


    global.MV.icp = {
        symmetric: symmetric,
        createSolver: createSolver,
        computeVertexNormals: computeVertexNormals,
        pcaOf: pcaOf,
        jacobi3: jacobi3,
        solve6: solve6,
        expSO3: expSO3,
    };
})(window);
