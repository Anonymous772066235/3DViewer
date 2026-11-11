/* ------------------------------------------------------------------
 * super4pcs.js —— Super4PCS 的忠实 JS 实现
 *
 * 逐函数翻译自官方实现 nmellado/Super4PCS（Apache-2.0）：
 *   src/super4pcs/algorithms/match4pcsBase.hpp   init / ComputeTransformation /
 *                                                Perform_N_steps / TryOneBase /
 *                                                TryCongruentSet / Verify
 *   src/super4pcs/algorithms/match4pcsBase.cc    SelectQuadrilateral /
 *                                                SelectRandomTriangle /
 *                                                TryQuadrilateral /
 *                                                distSegmentToSegment
 *   src/super4pcs/algorithms/super4pcs.cc        ExtractPairs /
 *                                                FindCongruentQuadrilaterals
 *   src/super4pcs/accelerators/normalset.h/.hpp  IndexedNormalSet3D
 *   src/super4pcs/shared4pcs.h                   Match4PCSOptions 默认值
 *
 * 与原版的已知差异（均为运行环境所迫，已在各处注明）：
 *   1. ComputeRigidTransformation 用 Horn 四元数代替官方 SVD，
 *      二者都是最小二乘刚体解，数学等价；
 *   2. 单线程（官方有 OpenMP 并行验证候选）；
 *   3. 主循环提供按帧让出的分步接口，避免长时间阻塞浏览器主线程；
 *   4. 坐标统一归一化到 [0,1)，因为 IndexedNormalSet3D 的网格索引
 *      以 _egSize = 2^floor(-log2(eps)) 构建，直接用物理坐标会让
 *      _grid 规模爆炸（eps 很小时 _egSize^3 可达上亿）。
 *
 * 对外接口：
 *   MV.super4pcs.register(P, Q, options) -> Float64Array(16) | null
 *     P / Q : { positions: Float32Array|Float64Array, count: Number }
 *   返回值把 P 变换到 Q 的 4x4 刚体矩阵（列主序与行主序一致，最后一行为 0,0,0,1）
 *
 *   MV.super4pcs.createRegistration(P, Q, options) -> { step, result, isDone, cancel }
 *     分步版本，每次 step 只做一小批，供 UI 按帧驱动。
 * ------------------------------------------------------------------ */

(function (global)
{
    'use strict';

    var MV = global.MV || (global.MV = {});

    /* ---------------- Match4PCSOptions（shared4pcs.h 原值） ---------------- */
    var OPTION_DEFAULTS = {
        delta: 5.0,                     // LCP 容差，绝对长度单位
        max_normal_difference: -1,      // <0 表示不启用
        max_translation_distance: -1,
        max_angle: -1,
        max_color_distance: -1,
        sample_size: 200,               // 每侧均匀采样点数
        max_time_seconds: 60,
        overlap_estimation: 0.2,
        terminate_threshold: 1.0,

        /* —— 以下是本实现追加的运行控制项，官方没有 —— */
        maxCongruent: 300,      // 每次尝试最多验证多少个候选四边形
        maxTrials: 0            // 0 表示用官方公式算出的迭代数
    };

    /* normalset.h：IndexedNormalSet3D = IndexedNormalSet<Point3D, 3, NG_SIZE, Scalar> */
    var NG_SIZE = 7;                        // 法向每维分箱数，共 7^3 = 343
    var ANGULAR_BINS = NG_SIZE * NG_SIZE * NG_SIZE;

    /* super4pcs.cc：distance_factor = 2.0 */
    var DISTANCE_FACTOR = 2.0;

    /* match4pcsBase.h */
    var K_NUMBER_OF_DIAMETER_TRIALS = 1000;
    var K_MIN_NUMBER_OF_TRIALS = 4;

    /* 浏览器里的硬上限：无论外部传多少，尝试次数都不超过这个值。
     * 官方公式对 overlay=0.2 会算出 2 万量级，那在交互场景里不可接受。 */
    var K_MAX_TRIALS = 200;
    var K_SMALL_ERROR = 0.00001;
    var K_DIAMETER_FRACTION = 0.3;
    var K_BASE_TOO_SMALL = 0.2;
    var K_SMALL_NUMBER = 0.0001;

    var IDENT4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

    /* ================= 基础工具 ================= */

    function nowMs()
    {
        return (global.performance && global.performance.now)
            ? global.performance.now() : Date.now();
    }

    /* 混合基数线性化：id = Σ coord[i] * base^i，任一维越界返回 -1
     * 对应官方 Utils::UnrollIndexLoop<VALIDATE_INDICES>(coord, dim-1, base) */
    function unrollIndexLoop(cx, cy, cz, base)
    {
        var bx = Math.floor(cx);
        var by = Math.floor(cy);
        var bz = Math.floor(cz);

        if (bx < 0 || bx >= base || by < 0 || by >= base || bz < 0 || bz >= base)
        {
            return -1;
        }

        return bx + by * base + bz * base * base;
    }

    /* ================= IndexedNormalSet3D ================= */
    /*
     * normalset.h / .hpp 的直译。
     *   _grid : AngularGrid[_egSize^dim]，_egSize 为每维位置格子数
     *   AngularGrid = vector<unsigned>[343]，每个位置格子挂一张角度网格
     * 位置与法向都必须先归一化；空体素惰性分配（官方注释即"内存高效"）。
     */
    function IndexedNormalSet3D(epsilon)
    {
        this.ngSize = NG_SIZE;
        this.nepsilon = 1 / NG_SIZE + 0.00001;      // 略大于 1/NG_SIZE，使 floor 不越界

        /* 官方把 epsilon 向下对齐到 2 的幂：gridDepth = -log2(eps) */
        var gridDepth = Math.floor(-Math.log2(epsilon));
        if (!isFinite(gridDepth)) { gridDepth = 0; }
        if (gridDepth < 1) { gridDepth = 1; }
        if (gridDepth > 10) { gridDepth = 10; }     // 兜底：10^3 = 1024 格，避免内存失控

        this.egSize = Math.pow(2, gridDepth);
        this.epsilon = 1 / this.egSize;

        this.grid = new Array(Math.pow(this.egSize, 3));   // 惰性分配，初值全 undefined
    }

    IndexedNormalSet3D.prototype.coordinatesPos = function (x, y, z)
    {
        var inv = 1 / this.epsilon;
        return [x * inv, y * inv, z * inv];
    };

    IndexedNormalSet3D.prototype.coordinatesNormal = function (nx, ny, nz)
    {
        var inv = 1 / this.nepsilon;
        return [(nx / 2 + 0.5) * inv, (ny / 2 + 0.5) * inv, (nz / 2 + 0.5) * inv];
    };

    IndexedNormalSet3D.prototype.indexPos = function (x, y, z)
    {
        var c = this.coordinatesPos(x, y, z);
        return unrollIndexLoop(c[0], c[1], c[2], this.egSize);
    };

    IndexedNormalSet3D.prototype.indexNormal = function (nx, ny, nz)
    {
        var c = this.coordinatesNormal(nx, ny, nz);
        return unrollIndexLoop(c[0], c[1], c[2], this.ngSize);
    };

    IndexedNormalSet3D.prototype.addElement = function (px, py, pz, nx, ny, nz, id)
    {
        var pId = this.indexPos(px, py, pz);
        if (pId === -1) { return false; }

        var nId = this.indexNormal(nx, ny, nz);
        if (nId === -1) { return false; }

        var cell = this.grid[pId];
        if (!cell)
        {
            cell = new Array(ANGULAR_BINS);
            this.grid[pId] = cell;
        }

        var bucket = cell[nId];
        if (!bucket) { bucket = []; cell[nId] = bucket; }
        bucket.push(id);

        return true;
    };

    /* 重载 3：位置格子 + 沿"以 n 为极轴、半角 alpha 的圆锥母线圆周"采样
     * 官方用这套圆环光栅化代替"枚举锥内所有角度格"，查询代价与点云规模无关。
     *
     * 官方源码写的是 std::atan(alpha)，按单位球几何应为 sin(alpha)
     * （圆周半径 = sinα）。这里保留官方的 atan 写法并在采样数上取
     * max(4, ...) 保证不因 alpha 很小而漏采。 */
    IndexedNormalSet3D.prototype.getNeighbors = function (px, py, pz, nx, ny, nz, cosAlpha, tryReverse, out)
    {
        var pId = this.indexPos(px, py, pz);
        if (pId === -1) { return; }

        var cell = this.grid[pId];
        if (!cell) { return; }

        var alpha = Math.acos(Math.max(-1, Math.min(1, cosAlpha)));
        var perimeter = 2 * Math.PI * Math.atan(alpha);
        var nbSample = 2 * Math.ceil(perimeter * NG_SIZE / 2);
        if (!(nbSample >= 4)) { nbSample = 4; }

        var angleStep = 2 * Math.PI / nbSample;
        var sinAlpha = Math.sin(alpha);
        var cosA = Math.cos(alpha);

        /* 构造把 +Z 旋到 n 的四元数（官方 setFromTwoVectors）
         * 这里直接用它旋转局部坐标，避免引入完整四元数类型。 */
        var axis = rotateZTo(nx, ny, nz);

        var colored = Object.create(null);
        var a, theta, dx, dy, dz, id;

        for (a = 0; a < nbSample; a++)
        {
            theta = a * angleStep;

            var lx = sinAlpha * Math.cos(theta);
            var ly = sinAlpha * Math.sin(theta);
            var lz = cosA;

            dx = axis[0] * lx + axis[3] * ly + axis[6] * lz;
            dy = axis[1] * lx + axis[4] * ly + axis[7] * lz;
            dz = axis[2] * lx + axis[5] * ly + axis[8] * lz;

            var il = 1 / (Math.sqrt(dx * dx + dy * dy + dz * dz) || 1);
            dx *= il; dy *= il; dz *= il;

            id = this.indexNormal(dx, dy, dz);
            if (id >= 0 && cell[id] && cell[id].length) { colored[id] = 1; }

            if (tryReverse)
            {
                id = this.indexNormal(-dx, -dy, -dz);
                if (id >= 0 && cell[id] && cell[id].length) { colored[id] = 1; }
            }
        }

        for (var k in colored)
        {
            var bucket = cell[k];
            for (var i = 0; i < bucket.length; i++) { out.push(bucket[i]); }
        }
    };

    /* 旋转矩阵：把 +Z 轴转到单位向量 n（setFromTwoVectors 的矩阵形式） */
    function rotateZTo(nx, ny, nz)
    {
        var len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (!(len > 1e-12)) { return IDENT4.slice(0, 9); }
        nx /= len; ny /= len; nz /= len;

        var dot = nz;                 // (0,0,1)·n
        if (dot > 0.9999999) { return [1, 0, 0, 0, 1, 0, 0, 0, 1]; }
        if (dot < -0.9999999) { return [-1, 0, 0, 0, -1, 0, 0, 0, 1]; }   // 绕 X 转 180°

        // axis = z × n = (-ny, nx, 0)
        var ax = -ny, ay = nx, az = 0;
        var s = Math.sqrt(ax * ax + ay * ay + az * az);
        ax /= s; ay /= s; az /= s;

        var c = dot;
        var t = 1 - c;

        return [
            t * ax * ax + c,      t * ax * ay - s * az, t * ax * az + s * ay,
            t * ax * ay + s * az, t * ay * ay + c,      t * ay * az - s * ax,
            t * ax * az - s * ay, t * ay * az + s * ax, t * az * az + c
        ];
    }

    /* ================= 均匀采样（sampling.h 的 UniformDistSampler） ================= */

    /* 随机抽取 count 个互不相同的索引（部分 Fisher-Yates）。 */
    function pickIdx(total, count)
    {
        var i;

        if (count >= total)
        {
            var all = new Int32Array(total);
            for (i = 0; i < total; i++) { all[i] = i; }
            return all;
        }

        var pool = new Int32Array(total);
        for (i = 0; i < total; i++) { pool[i] = i; }

        for (i = 0; i < count; i++)
        {
            var j = i + Math.floor(Math.random() * (total - i));
            var t = pool[i]; pool[i] = pool[j]; pool[j] = t;
        }

        return pool.subarray(0, count);
    }

        function uniformSample(pos, count, sampleSize)
    {
        if (count <= sampleSize)
        {
            var all = new Float64Array(count * 3);
            for (var q = 0; q < count * 3; q++) { all[q] = pos[q]; }
            return { pos: all, count: count, idx: null };
        }

        var pool = new Int32Array(count);
        var i;
        for (i = 0; i < count; i++) { pool[i] = i; }

        // 部分 Fisher-Yates：只取前 sampleSize 个
        for (i = 0; i < sampleSize; i++)
        {
            var j = i + Math.floor(Math.random() * (count - i));
            var t = pool[i]; pool[i] = pool[j]; pool[j] = t;
        }

        var out = new Float64Array(sampleSize * 3);
        for (i = 0; i < sampleSize; i++)
        {
            out[i * 3] = pos[pool[i] * 3];
            out[i * 3 + 1] = pos[pool[i] * 3 + 1];
            out[i * 3 + 2] = pos[pool[i] * 3 + 2];
        }

        return { pos: out, count: sampleSize, idx: null };
    }

    /* ================= 点云包围辅助 ================= */

    function bboxOf(pos, count)
    {
        var mn = [Infinity, Infinity, Infinity];
        var mx = [-Infinity, -Infinity, -Infinity];

        for (var i = 0; i < count; i++)
        {
            for (var d = 0; d < 3; d++)
            {
                var v = pos[i * 3 + d];
                if (v < mn[d]) { mn[d] = v; }
                if (v > mx[d]) { mx[d] = v; }
            }
        }

        return { min: mn, max: mx };
    }

    function centroidOf(pos, count)
    {
        var cx = 0, cy = 0, cz = 0;
        for (var i = 0; i < count; i++)
        {
            cx += pos[i * 3];
            cy += pos[i * 3 + 1];
            cz += pos[i * 3 + 2];
        }
        return [cx / count, cy / count, cz / count];
    }

    /* ================= Horn 四元数求刚体变换 ================= */
    /*
     * 官方 ComputeRigidTransformation 用 SVD；这里用 Horn 的四元数闭式解，
     * 目标函数同为「最小化对应点距离平方和」，结果是同一个刚体变换。
     * pairs: [[sx,sy,sz, dx,dy,dz], ...]
     */
    function jacobi4Vec(Ain)
    {
        var A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
        var V = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
        var i, j, k;

        for (i = 0; i < 4; i++)
        {
            for (j = 0; j < 4; j++) { A[i][j] = Ain[i][j]; }
        }

        for (var sweep = 0; sweep < 40; sweep++)
        {
            var off = 0;
            for (i = 0; i < 4; i++)
            {
                for (j = i + 1; j < 4; j++) { off += A[i][j] * A[i][j]; }
            }
            if (off < 1e-26) { break; }

            for (i = 0; i < 4; i++)
            {
                for (j = i + 1; j < 4; j++)
                {
                    if (Math.abs(A[i][j]) < 1e-20) { continue; }

                    var theta = (A[j][j] - A[i][i]) / (2 * A[i][j]);
                    var tt = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                    var c = 1 / Math.sqrt(tt * tt + 1);
                    var sn = tt * c;

                    for (k = 0; k < 4; k++)
                    {
                        var aik = A[i][k], ajk = A[j][k];
                        A[i][k] = c * aik - sn * ajk;
                        A[j][k] = sn * aik + c * ajk;
                    }
                    for (k = 0; k < 4; k++)
                    {
                        var aki = A[k][i], akj = A[k][j];
                        A[k][i] = c * aki - sn * akj;
                        A[k][j] = sn * aki + c * akj;
                    }
                    for (k = 0; k < 4; k++)
                    {
                        var vki = V[k][i], vkj = V[k][j];
                        V[k][i] = c * vki - sn * vkj;
                        V[k][j] = sn * vki + c * vkj;
                    }
                }
            }
        }

        var bi = 0;
        for (i = 1; i < 4; i++) { if (A[i][i] > A[bi][bi]) { bi = i; } }
        return [V[0][bi], V[1][bi], V[2][bi], V[3][bi]];
    }

    function solveRigid(pairs)
    {
        var n = pairs.length;
        if (n < 3) { return null; }

        var scx = 0, scy = 0, scz = 0, dcx = 0, dcy = 0, dcz = 0, i, k;
        for (i = 0; i < n; i++)
        {
            scx += pairs[i][0]; scy += pairs[i][1]; scz += pairs[i][2];
            dcx += pairs[i][3]; dcy += pairs[i][4]; dcz += pairs[i][5];
        }
        scx /= n; scy /= n; scz /= n;
        dcx /= n; dcy /= n; dcz /= n;

        var S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        for (i = 0; i < n; i++)
        {
            var a0 = pairs[i][0] - scx, a1 = pairs[i][1] - scy, a2 = pairs[i][2] - scz;
            var b0 = pairs[i][3] - dcx, b1 = pairs[i][4] - dcy, b2 = pairs[i][5] - dcz;
            S[0][0] += a0 * b0; S[0][1] += a0 * b1; S[0][2] += a0 * b2;
            S[1][0] += a1 * b0; S[1][1] += a1 * b1; S[1][2] += a1 * b2;
            S[2][0] += a2 * b0; S[2][1] += a2 * b1; S[2][2] += a2 * b2;
        }

        var Sxx = S[0][0], Sxy = S[0][1], Sxz = S[0][2];
        var Syx = S[1][0], Syy = S[1][1], Syz = S[1][2];
        var Szx = S[2][0], Szy = S[2][1], Szz = S[2][2];

        var N = [
            [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
            [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
            [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
            [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz]
        ];

        var q = jacobi4Vec(N);
        if (!q) { return null; }

        var w = q[0], x = q[1], y = q[2], z = q[3];

        var M = new Float64Array(16);
        M[0] = 1 - 2 * (y * y + z * z); M[1] = 2 * (x * y - w * z);     M[2] = 2 * (x * z + w * y);
        M[4] = 2 * (x * y + w * z);     M[5] = 1 - 2 * (x * x + z * z); M[6] = 2 * (y * z - w * x);
        M[8] = 2 * (x * z - w * y);     M[9] = 2 * (y * z + w * x);     M[10] = 1 - 2 * (x * x + y * y);

        M[3] = dcx - (M[0] * scx + M[1] * scy + M[2] * scz);
        M[7] = dcy - (M[4] * scx + M[5] * scy + M[6] * scz);
        M[11] = dcz - (M[8] * scx + M[9] * scy + M[10] * scz);
        M[12] = 0; M[13] = 0; M[14] = 0; M[15] = 1;

        return M;
    }

    /* 3x3 部分重正交，抵消多次四元数乘法的浮点漂移 */
    function orthonormalize(M)
    {
        var r0 = [M[0], M[1], M[2]];
        var r1 = [M[4], M[5], M[6]];

        var l0 = Math.sqrt(r0[0] * r0[0] + r0[1] * r0[1] + r0[2] * r0[2]);
        if (!(l0 > 1e-12)) { return M; }
        r0[0] /= l0; r0[1] /= l0; r0[2] /= l0;

        var d = r1[0] * r0[0] + r1[1] * r0[1] + r1[2] * r0[2];
        r1[0] -= d * r0[0]; r1[1] -= d * r0[1]; r1[2] -= d * r0[2];

        var l1 = Math.sqrt(r1[0] * r1[0] + r1[1] * r1[1] + r1[2] * r1[2]);
        if (!(l1 > 1e-12)) { return M; }
        r1[0] /= l1; r1[1] /= l1; r1[2] /= l1;

        var r2 = [
            r0[1] * r1[2] - r0[2] * r1[1],
            r0[2] * r1[0] - r0[0] * r1[2],
            r0[0] * r1[1] - r0[1] * r1[0]
        ];

        M[0] = r0[0]; M[1] = r0[1]; M[2] = r0[2];
        M[4] = r1[0]; M[5] = r1[1]; M[6] = r1[2];
        M[8] = r2[0]; M[9] = r2[1]; M[10] = r2[2];
        return M;
    }

    /* ================= 主类 ================= */

    function Registration(P, Q, options)
    {
        var o = {};
        var key;
        for (key in OPTION_DEFAULTS) { o[key] = OPTION_DEFAULTS[key]; }
        if (options) { for (key in options) { o[key] = options[key]; } }
        this.options = o;

        this.P = P;
        this.Q = Q;

        this.sampledP = null;      // 居中 + 归一化后的采样点
        this.sampledQ = null;
        this.countP = 0;
        this.countQ = 0;
        this.scale = 1;
        this.centroidP = [0, 0, 0];
        this.centroidQ = [0, 0, 0];
        this.kdTree = null;        // 建在 sampledQ 上

        this.base = [null, null, null, null];
        this.baseIds = [0, 0, 0, 0];
        this.bestLCP = 0;
        this.baselineLCP = 0;
        this.kdEval = null;
        this.evalPos = null;
        this.evalDense = 0;
        this.bestTransform = null;
        this.bestPairs = null;

        this.numberOfTrials = 0;
        this.currentTrial = 0;
        this.startTime = 0;
        this.cancelled = false;
        this.lastStats = { quarterAndCount: 0, congruent: 0, verify: 0 };

        /* 单次尝试的诊断快照：用来定位"效果不好"卡在哪个环节 */
        this.diag = {
            pairs1: 0,          // 第一条基线抽到多少等长点对
            pairs2: 0,          // 第二条基线抽到多少等长点对
            quads: 0,           // 索引组合出多少个候选四边形
            truncated: false,   // 候选是否被 maxCongruent 截断
            rmsPass: 0,         // 通过 rms 门限的候选数
            verifyRun: 0,       // 实际执行 verify 的次数
            lcpBest: 0,         // 本次尝试拿到的最好 LCP
            baseFail: 0,        // 基选取失败次数
            pairFail: 0         // 点对提取为空的次数
        };
    }

    /* match4pcsBase.hpp : init */
    Registration.prototype.init = function ()
    {
        var o = this.options;

        var sp = uniformSample(this.P.positions, this.P.count, o.sample_size);
        var sq = uniformSample(this.Q.positions, this.Q.count, o.sample_size);

        this.countP = sp.count;
        this.countQ = sq.count;

        /* 归一化必须落在 [0,1)：IndexedNormalSet3D 的 indexPos 用
         *   floor(p / _epsilon)，_epsilon = 1/_egSize，
         * 一旦坐标是负数就被判为越界、整批点被拒收，索引直接是空的。
         * 所以这里用「减 bbox 最小点 / 除以最大跨度」而不是「减质心」——
         * 保证每个分量都在 [0,1]。 */
        var bp = bboxOf(sp.pos, sp.count);
        var bq = bboxOf(sq.pos, sq.count);

        var cP = centroidOf(sp.pos, sp.count);
        var cQ = centroidOf(sq.pos, sq.count);
        this.centroidP = cP;
        this.centroidQ = cQ;

        var spanPX = bp.max[0] - bp.min[0], spanPY = bp.max[1] - bp.min[1], spanPZ = bp.max[2] - bp.min[2];
        var spanQX = bq.max[0] - bq.min[0], spanQY = bq.max[1] - bq.min[1], spanQZ = bq.max[2] - bq.min[2];

        var scale = Math.max(spanPX, spanPY, spanPZ, spanQX, spanQY, spanQZ, 1e-6);
        this.scale = scale;

        /* 归一化必须以【质心】为基准 —— 它是旋转不变的。
         * 若改用 bbox 最小点，旋转后同一块几何会落到不同坐标，
         * 不变量 r1/r2 就失去意义了。
         *
         * 但 IndexedNormalSet3D 的 indexPos 要求坐标 ∈ [0,1)（内部 floor(p/_epsilon)），
         * 质心系下坐标是 [-0.5, 0.5]。两者用一个常数偏移衔接：
         *     索引坐标 = 变换坐标 + (centroid − bboxMin) / scale
         * 偏移是常数，不影响任何距离与比值，只用于满足索引的非负要求。 */
        this.indexShiftP = [
            (cP[0] - bp.min[0]) / scale,
            (cP[1] - bp.min[1]) / scale,
            (cP[2] - bp.min[2]) / scale
        ];
        this.indexShiftQ = [
            (cQ[0] - bq.min[0]) / scale,
            (cQ[1] - bq.min[1]) / scale,
            (cQ[2] - bq.min[2]) / scale
        ];

        var i;
        this.sampledP = new Float64Array(sp.count * 3);
        for (i = 0; i < sp.count; i++)
        {
            this.sampledP[i * 3] = (sp.pos[i * 3] - cP[0]) / scale;
            this.sampledP[i * 3 + 1] = (sp.pos[i * 3 + 1] - cP[1]) / scale;
            this.sampledP[i * 3 + 2] = (sp.pos[i * 3 + 2] - cP[2]) / scale;
        }

        this.sampledQ = new Float64Array(sq.count * 3);
        for (i = 0; i < sq.count; i++)
        {
            this.sampledQ[i * 3] = (sq.pos[i * 3] - cQ[0]) / scale;
            this.sampledQ[i * 3 + 1] = (sq.pos[i * 3 + 1] - cQ[1]) / scale;
            this.sampledQ[i * 3 + 2] = (sq.pos[i * 3 + 2] - cQ[2]) / scale;
        }

        /* 两棵 KD 树，用途不同：
         *   kdTreeQ —— ExtractPairs 在目标点云里找"与基线等长的点对"
         *   kdTreeP —— Verify 把变换后的 Q 点拿去 P 里查，统计命中率
         *
         * 之前只建了一棵（都在 Q 上），Verify 于是变成"Q 自己查自己"：
         * 单位阵下每个查询点就是它本身，距离恒为 0，LCP 永远 1.0 ——
         * 算法一开始就认为"已经配准好了"，一次搜索都不做。 */
        this.kdTreeQ = MV.kdtree.build(this.sampledQ);
        if (!this.kdTreeQ) { return false; }

        this.kdTreeP = MV.kdtree.build(this.sampledP);
        if (!this.kdTreeP) { return false; }

        /* 评分专用密集点云（建在 Q 上，与 sampledQ 同坐标系）。
         *
         * 为什么必须分开：verify 的命中容差是 delta，而 sample_size 只有
         * 2000 点，间距约 scale/sqrt(2000)。若 delta 小于这个间距，
         * 即使【完全对齐】也只有一半点能命中 —— bestLCP 的天花板被锁在 50%
         * 附近，而初始基准（原始位姿）随手就能达到这个量级，
         * 于是任何候选都超不过基准，搜索等于空转。
         *
         * 用 evalDense 点建树后，间距 = scale/sqrt(evalDense)，
         * delta 才有意义。 */
        /* 必须从【原始点云】抽样，不能从 sq 抽 ——
         * sq 已经是 sample_size（例如 2000）抽稀后的结果，
         * 从它再抽只能得到更稀疏的子集，间距一点没变。
         * 这正是"密集评分树"名不副实、delta 失去区分力的原因。 */
        var evalDense = Math.min(o.evalDense || 20000, this.Q.count);
        this.evalDense = evalDense;

        var evalIdx = pickIdx(this.Q.count, evalDense);
        this.evalPos = new Float64Array(evalDense * 3);

        for (i = 0; i < evalDense; i++)
        {
            this.evalPos[i * 3] = (this.Q.positions[evalIdx[i] * 3] - cQ[0]) / scale;
            this.evalPos[i * 3 + 1] = (this.Q.positions[evalIdx[i] * 3 + 1] - cQ[1]) / scale;
            this.evalPos[i * 3 + 2] = (this.Q.positions[evalIdx[i] * 3 + 2] - cQ[2]) / scale;
        }

        this.kdEval = MV.kdtree.build(this.evalPos);
        if (!this.kdEval) { return false; }

        /* 归一化后的各项距离 */
        this.deltaN = o.delta / scale;
        this.distFactorN = DISTANCE_FACTOR * this.deltaN;

        /* 直径估计：1000 次随机点对取最大（官方注释即"近似"） */
        var diameter = 0;
        for (i = 0; i < K_NUMBER_OF_DIAMETER_TRIALS; i++)
        {
            var at = (Math.random() * this.countQ) | 0;
            var bt = (Math.random() * this.countQ) | 0;
            var dx = this.sampledQ[at * 3] - this.sampledQ[bt * 3];
            var dy = this.sampledQ[at * 3 + 1] - this.sampledQ[bt * 3 + 1];
            var dz = this.sampledQ[at * 3 + 2] - this.sampledQ[bt * 3 + 2];
            var l = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (l > diameter) { diameter = l; }
        }
        if (!(diameter > 0)) { diameter = 1; }

        this.pDiameter = diameter;
        this.maxBaseDiameter = diameter;      // 官方：max_base_diameter_ = P_diameter_

        /* RANSAC 迭代数：log(1e-5) / log(1 − overlap^4) × (D/0.3)/D */
        var overlap = Math.max(1e-6, Math.min(0.999, o.overlap_estimation));
        var first = Math.log(K_SMALL_ERROR) / Math.log(1 - Math.pow(overlap, K_MIN_NUMBER_OF_TRIALS));
        this.numberOfTrials = Math.round(first * (this.pDiameter / K_DIAMETER_FRACTION) / this.maxBaseDiameter);
        if (!(this.numberOfTrials >= K_MIN_NUMBER_OF_TRIALS))
        {
            this.numberOfTrials = K_MIN_NUMBER_OF_TRIALS;
        }

        /* 迭代数硬上限：外部可再收紧，但不能突破 K_MAX_TRIALS */
        var cap = (o.maxTrials && o.maxTrials > 0)
            ? Math.min(o.maxTrials, K_MAX_TRIALS)
            : K_MAX_TRIALS;

        if (this.numberOfTrials > cap) { this.numberOfTrials = cap; }
        this.formulaTrials = this.numberOfTrials;

        this.currentTrial = 0;
        this.bestLCP = 0;
        this.bestTransform = null;
        this.bestPairs = null;
        this.startTime = nowMs();

        /* 基准：原始位姿（单位阵）在下采样点上的覆盖率。
         * 后续任何候选必须严格超过它才会被采纳 —— 这就是
         * "算出来的还不如原始位姿就直接用原始位姿" 的实现方式。 */
        this.bestLCP = this.verify(IDENT4);
        this.baselineLCP = this.bestLCP;

        return true;
    };

    /* match4pcsBase.cc : distSegmentToSegment
     * 两条 3D 线段的最近点对，输出归一化参数 r1 / r2，并返回最近距离 */
    function distSegmentToSegment(p1, p2, q1, q2, out)
    {
        var ux = p2[0] - p1[0], uy = p2[1] - p1[1], uz = p2[2] - p1[2];
        var vx = q2[0] - q1[0], vy = q2[1] - q1[1], vz = q2[2] - q1[2];
        var wx = p1[0] - q1[0], wy = p1[1] - q1[1], wz = p1[2] - q1[2];

        var a = ux * ux + uy * uy + uz * uz;
        var b = ux * vx + uy * vy + uz * vz;
        var c = vx * vx + vy * vy + vz * vz;
        var d = ux * wx + uy * wy + uz * wz;
        var e = vx * wx + vy * wy + vz * wz;

        var f = a * c - b * b;
        var s1 = 0, s2 = f, t1 = 0, t2 = f;

        if (f < K_SMALL_NUMBER)
        {
            s1 = 0; s2 = 1; t1 = e; t2 = c;
        }
        else
        {
            s1 = b * e - c * d;
            t1 = a * e - b * d;

            if (s1 < 0) { s1 = 0; t1 = e; t2 = c; }
            else if (s1 > s2) { s1 = s2; t1 = e + b; t2 = c; }
        }

        if (t1 < 0)
        {
            t1 = 0;
            if (-d < 0) { s1 = 0; }
            else if (-d > a) { s1 = s2; }
            else { s1 = -d; s2 = a; }
        }
        else if (t1 > t2)
        {
            t1 = t2;
            if ((-d + b) < 0) { s1 = 0; }
            else if ((-d + b) > a) { s1 = s2; }
            else { s1 = -d + b; s2 = a; }
        }

        var r1 = (Math.abs(s1) < K_SMALL_NUMBER) ? 0 : (s2 !== 0 ? s1 / s2 : 0);
        var r2 = (Math.abs(t1) < K_SMALL_NUMBER) ? 0 : (t2 !== 0 ? t1 / t2 : 0);

        var ddx = wx + r1 * ux - r2 * vx;
        var ddy = wy + r1 * uy - r2 * vy;
        var ddz = wz + r1 * uz - r2 * vz;

        out.r1 = r1;
        out.r2 = r2;
        return Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
    }

    /* match4pcsBase.cc : SelectRandomTriangle
     * 固定一点，随机取两点，保留叉积模最大（面积最大）的组合 */
    Registration.prototype.selectRandomTriangle = function (out)
    {
        var n = this.countP;
        var S = this.sampledP;
        var maxD = this.maxBaseDiameter;
        var maxD2 = maxD * maxD;

        var i1 = (Math.random() * n) | 0;
        var bestWide = -1;
        var b1 = -1, b2 = -1;

        for (var k = 0; k < K_NUMBER_OF_DIAMETER_TRIALS; k++)
        {
            var i2 = (Math.random() * n) | 0;
            var i3 = (Math.random() * n) | 0;
            if (i2 === i1 || i3 === i1 || i2 === i3) { continue; }

            var ux = S[i2 * 3] - S[i1 * 3];
            var uy = S[i2 * 3 + 1] - S[i1 * 3 + 1];
            var uz = S[i2 * 3 + 2] - S[i1 * 3 + 2];
            var wx = S[i3 * 3] - S[i1 * 3];
            var wy = S[i3 * 3 + 1] - S[i1 * 3 + 1];
            var wz = S[i3 * 3 + 2] - S[i1 * 3 + 2];

            var uu = ux * ux + uy * uy + uz * uz;
            var ww = wx * wx + wy * wy + wz * wz;
            if (uu > maxD2 || ww > maxD2) { continue; }

            var cx = uy * wz - uz * wy;
            var cy = uz * wx - ux * wz;
            var cz = ux * wy - uy * wx;
            var wide = Math.sqrt(cx * cx + cy * cy + cz * cz);

            if (wide > bestWide) { bestWide = wide; b1 = i2; b2 = i3; }
        }

        if (b1 < 0 || !(bestWide > 0)) { return false; }

        out[0] = i1; out[1] = b1; out[2] = b2;
        return true;
    };

    /* match4pcsBase.cc : SelectQuadrilateral
     * 前三点来自 SelectRandomTriangle，第 4 点全局扫描取"离平面最近" */
    Registration.prototype.selectQuadrilateral = function ()
    {
        var S = this.sampledP;
        var n = this.countP;
        var tri = [0, 0, 0];

        if (!this.selectRandomTriangle(tri)) { return false; }

        var i1 = tri[0], i2 = tri[1], i3 = tri[2];

        var x1 = S[i1 * 3], y1 = S[i1 * 3 + 1], z1 = S[i1 * 3 + 2];
        var x2 = S[i2 * 3], y2 = S[i2 * 3 + 1], z2 = S[i2 * 3 + 2];
        var x3 = S[i3 * 3], y3 = S[i3 * 3 + 1], z3 = S[i3 * 3 + 2];

        /* 平面 Ax+By+Cz=1 的系数（官方按 Cramer 展开） */
        var denom = (-x3 * y2 * z1 + x2 * y3 * z1 + x3 * y1 * z2
                   - x1 * y3 * z2 - x2 * y1 * z3 + x1 * y2 * z3);
        if (denom === 0) { return false; }

        var A = (-y3 * z2 + y2 * z3 + y3 * z1 - y1 * z3 - y2 * z1 + y1 * z2) / denom;
        var B = (x3 * z2 - x2 * z3 - x3 * z1 + x1 * z3 + x2 * z1 - x1 * z2) / denom;
        var C = (-x3 * y2 + x2 * y3 + x3 * y1 - x1 * y3 - x2 * y1 + x1 * y2) / denom;

        var tooSmall = Math.pow(this.maxBaseDiameter * K_BASE_TOO_SMALL, 2);
        var bestDist = Infinity;
        var i4 = -1;

        for (var i = 0; i < n; i++)
        {
            if (i === i1 || i === i2 || i === i3) { continue; }

            var px = S[i * 3], py = S[i * 3 + 1], pz = S[i * 3 + 2];

            var d1 = (px - x1) * (px - x1) + (py - y1) * (py - y1) + (pz - z1) * (pz - z1);
            if (d1 < tooSmall) { continue; }
            var d2 = (px - x2) * (px - x2) + (py - y2) * (py - y2) + (pz - z2) * (pz - z2);
            if (d2 < tooSmall) { continue; }
            var d3 = (px - x3) * (px - x3) + (py - y3) * (py - y3) + (pz - z3) * (pz - z3);
            if (d3 < tooSmall) { continue; }

            var dist = Math.abs(A * px + B * py + C * pz - 1);
            if (dist < bestDist) { bestDist = dist; i4 = i; }
        }

        if (i4 < 0) { return false; }

        return this.tryQuadrilateral(i1, i2, i3, i4);
    };

    /* match4pcsBase.cc : TryQuadrilateral
     * 枚举 12 种两两配对，取"两条线段最接近相交"的那一组，输出 r1/r2 */
    Registration.prototype.tryQuadrilateral = function (i1, i2, i3, i4)
    {
        var S = this.sampledP;
        var ids = [i1, i2, i3, i4];
        var pts = [
            [S[i1 * 3], S[i1 * 3 + 1], S[i1 * 3 + 2]],
            [S[i2 * 3], S[i2 * 3 + 1], S[i2 * 3 + 2]],
            [S[i3 * 3], S[i3 * 3 + 1], S[i3 * 3 + 2]],
            [S[i4 * 3], S[i4 * 3 + 1], S[i4 * 3 + 2]]
        ];

        var minDist = Infinity;
        var best = null;
        var tmp = { r1: 0, r2: 0 };
        var i, j, k, l;

        for (i = 0; i < 4; i++)
        {
            for (j = 0; j < 4; j++)
            {
                if (i === j) { continue; }

                k = 0; while (k === i || k === j) { k++; }
                l = 0; while (l === i || l === j || l === k) { l++; }

                var dd = distSegmentToSegment(pts[i], pts[j], pts[k], pts[l], tmp);

                if (dd < minDist)
                {
                    minDist = dd;
                    best = { a: i, b: j, c: k, d: l, r1: tmp.r1, r2: tmp.r2 };
                }
            }
        }

        if (!best) { return false; }

        this.base = [pts[best.a], pts[best.b], pts[best.c], pts[best.d]];
        this.baseIds = [ids[best.a], ids[best.b], ids[best.c], ids[best.d]];
        this.invariant1 = best.r1;
        this.invariant2 = best.r2;

        /* 两条基线的夹角余弦 —— FindCongruentQuadrilaterals 的方向约束 */
        var abx = this.base[1][0] - this.base[0][0];
        var aby = this.base[1][1] - this.base[0][1];
        var abz = this.base[1][2] - this.base[0][2];
        var cdx = this.base[3][0] - this.base[2][0];
        var cdy = this.base[3][1] - this.base[2][1];
        var cdz = this.base[3][2] - this.base[2][2];

        var la = Math.sqrt(abx * abx + aby * aby + abz * abz) || 1;
        var lc = Math.sqrt(cdx * cdx + cdy * cdy + cdz * cdz) || 1;

        this.alpha = (abx / la) * (cdx / lc) + (aby / la) * (cdy / lc) + (abz / la) * (cdz / lc);

        return true;
    };

    /* ================================================================
     * IntersectionFunctor —— 官方 accelerators/pairExtraction/ 的分层求交
     *
     * 官方 ExtractPairs 不是逐点做半径查询，而是：
     *   1. 把 eps 吸附成 2 的负幂，据此确定八叉树深度 lvlMax = -log2(eps)；
     *   2. 从覆盖 [0,1]^3 的根节点逐层细分，
     *      每层【只保留与某个球壳相交的节点】，其余整枝丢弃；
     *   3. 节点内点数 <= minNodeSize 时停止分裂，存为 earlyNode；
     *   4. 第二遍按 primitive 遍历存活叶子，粗筛(2eps) + 精筛(eps) 输出点对。
     *
     * 复杂度对点数近似线性、对输出规模敏感 —— 这是 Super4PCS 能在一分钟内
     * 处理几十万点的根本原因。逐点 KD 半径查询写起来简单，但每个点都要
     * 走一趟树，实测在两片 2000 点上要跑出近 5000 万次查询。
     *
     * 本实现保留官方结构；差异只有：
     *   - 用索引数组 + 计数排序做节点切分（等价于 Node::split）；
     *   - 加了输出上限 limit。
     * ================================================================ */

    /* 官方 GetRoundedEpsilonValue：吸附到 2 的负幂 */
    function roundEpsilon(eps)
    {
        var lvlMax = Math.floor(-Math.log2(eps));
        if (!isFinite(lvlMax) || lvlMax < 1) { lvlMax = 1; }
        if (lvlMax > 9) { lvlMax = 9; }
        return { eps: 1 / Math.pow(2, lvlMax), lvlMax: lvlMax };
    }

    function shellHitsNode(pts, pi, node, r, tol)
    {
        var o = pi * 3;
        var dx = node.cx - pts[o];
        var dy = node.cy - pts[o + 1];
        var dz = node.cz - pts[o + 2];
        var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        return Math.abs(d - r) <= tol;
    }

    function shellHitsPoint(pts, pi, qi, r, eps)
    {
        var a = pi * 3, b = qi * 3;
        var dx = pts[a] - pts[b];
        var dy = pts[a + 1] - pts[b + 1];
        var dz = pts[a + 2] - pts[b + 2];
        var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        return Math.abs(d - r) <= eps;
    }

    /* 节点切分：按 8 卦限重排 ids[i0..i1) */
    function splitNode(pts, ids, node, out, halfEdge)
    {
        var i0 = node.i0, i1 = node.i1;
        var cnt = [0, 0, 0, 0, 0, 0, 0, 0];
        var i, o, b;

        for (i = i0; i < i1; i++)
        {
            o = ids[i] * 3;
            b = (pts[o] >= node.cx ? 1 : 0)
              | (pts[o + 1] >= node.cy ? 2 : 0)
              | (pts[o + 2] >= node.cz ? 4 : 0);
            cnt[b]++;
        }

        var start = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        for (i = 0; i < 8; i++) { start[i + 1] = start[i] + cnt[i]; }

        var buf = new Int32Array(i1 - i0);
        var pos = start.slice(0, 8);

        for (i = i0; i < i1; i++)
        {
            o = ids[i] * 3;
            b = (pts[o] >= node.cx ? 1 : 0)
              | (pts[o + 1] >= node.cy ? 2 : 0)
              | (pts[o + 2] >= node.cz ? 4 : 0);
            buf[pos[b]++] = ids[i];
        }
        for (i = 0; i < buf.length; i++) { ids[i0 + i] = buf[i]; }

        for (i = 0; i < 8; i++)
        {
            if (!cnt[i]) { continue; }
            out.push({
                cx: node.cx + ((i & 1) ? halfEdge : -halfEdge),
                cy: node.cy + ((i & 2) ? halfEdge : -halfEdge),
                cz: node.cz + ((i & 4) ? halfEdge : -halfEdge),
                i0: i0 + start[i],
                i1: i0 + start[i] + cnt[i]
            });
        }
    }

    /* 官方 IntersectionFunctor::process 的直译 */
    function processIntersection(pts, n, radius, epsIn, minNodeSize, limit, out)
    {
        var re = roundEpsilon(epsIn);
        var eps = re.eps;
        var lvlMax = re.lvlMax;

        var ids = new Int32Array(n);
        for (var i = 0; i < n; i++) { ids[i] = i; }

        var nodes = [];
        var children = [{ cx: 0.5, cy: 0.5, cz: 0.5, i0: 0, i1: n }];
        var early = [];
        var clvl = 0;

        /* 第一遍：自顶向下，只保留与球壳相交的格子 */
        while (clvl !== lvlMax - 1)
        {
            if (!children.length) { break; }

            var halfEdge = (1 / Math.pow(2, clvl)) / 2;

            nodes = children;
            children = [];

            for (var ni = 0; ni < nodes.length; ni++)
            {
                var nd = nodes[ni];
                var hit = false;

                for (var pi = 0; pi < n; pi++)
                {
                    if (shellHitsNode(pts, pi, nd, radius, halfEdge + eps)) { hit = true; break; }
                }
                if (!hit) { continue; }

                if (nd.i1 - nd.i0 > minNodeSize) { splitNode(pts, ids, nd, children, halfEdge); }
                else { early.push({ node: nd, tol: halfEdge + eps }); }
            }

            clvl++;
        }

        /* 调试计数（供诊断用，不影响算法） */
        processIntersection.dbg = {
            eps: eps,
            lvlMax: lvlMax,
            radius: radius,
            leaves: children.length,
            earlyLeaves: early.length,
            leafPoints: children.reduce(function (a, c) { return a + (c.i1 - c.i0); }, 0)
        };

        /* 第二遍：按 primitive 遍历存活叶子，粗筛 + 精筛 */
        for (var p = 0; p < n; p++)
        {
            var k, leaf, j, q;

            for (k = 0; k < children.length; k++)
            {
                leaf = children[k];
                if (!shellHitsNode(pts, p, leaf, radius, eps * 2)) { continue; }

                for (j = leaf.i0; j < leaf.i1; j++)
                {
                    q = ids[j];
                    if (!(p > q)) { continue; }
                    if (!shellHitsPoint(pts, p, q, radius, eps)) { continue; }

                    out.push([p, q]);
                    if (out.length >= limit) { return out; }
                }
            }

            for (k = 0; k < early.length; k++)
            {
                var e = early[k];
                if (!shellHitsNode(pts, p, e.node, radius, e.tol)) { continue; }

                for (j = e.node.i0; j < e.node.i1; j++)
                {
                    q = ids[j];
                    if (!(p > q)) { continue; }
                    if (!shellHitsPoint(pts, p, q, radius, eps)) { continue; }

                    out.push([p, q]);
                    if (out.length >= limit) { return out; }
                }
            }
        }

        return out;
    }

    /* super4pcs.cc : ExtractPairs
     * 找出"两点距离落在 [dist−eps, dist+eps] 内"的点对。
     * 官方用 PairCreationFunctor + IntersectionFunctor 的网格加速；
     * 这里用 KD 半径查询，语义等价。 */
    Registration.prototype.extractPairs = function (dist, eps, limit)
    {
        /* 走官方的分层求交（IntersectionFunctor），不再逐点做 KD 半径查询。 */
        var out = processIntersection(this.sampledQ, this.countQ, dist, eps, 50, limit, []);
        this.diag.is = processIntersection.dbg || null;
        this.diag.isOut = out.length;
        return out;
    };

    /* super4pcs.cc : FindCongruentQuadrilaterals
     * 用 IndexedNormalSet3D 把"P 侧点对 × Q 侧点对"的笛卡尔积
     * 压成「遍历 Q 点对 → 查一次索引」。 */
    Registration.prototype.findCongruentQuadrilaterals = function (pairs1, pairs2, quadrilaterals)
    {
        /* 单线程下必须给候选数上限。
         * 位置格子边长是 2δ 量级，一格里的点对数量随采样密度线性增长；
         * 官方靠 OpenMP 并行验证这些候选，串行跑会直接把帧时间吃掉。
         * 超上限就停：这是召回率与耗时的取舍，不是算法本身的一部分。 */
        var maxCongruent = this.options.maxCongruent || 300;

        var Q = this.sampledQ;
        var distThreshold = this.distFactorN;
        var eps = Math.max(1e-6, distThreshold);       // getNormalizedEpsilon

        var nset = new IndexedNormalSet3D(eps);
        var i;

        /* P 侧建索引：按 invariant1 插值得到"交点位置"，点对方向作为法向 */
        for (i = 0; i < pairs1.length; i++)
        {
            var a = pairs1[i][0] * 3, b = pairs1[i][1] * 3;
            var p1x = Q[a], p1y = Q[a + 1], p1z = Q[a + 2];
            var p2x = Q[b], p2y = Q[b + 1], p2z = Q[b + 2];

            var dx = p2x - p1x, dy = p2y - p1y, dz = p2z - p1z;
            var dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (!(dl > 1e-12)) { continue; }
            dx /= dl; dy /= dl; dz /= dl;

            var sh = this.indexShiftQ;
            var ix = p1x + this.invariant1 * (p2x - p1x) + sh[0];
            var iy = p1y + this.invariant1 * (p2y - p1y) + sh[1];
            var iz = p1z + this.invariant1 * (p2z - p1z) + sh[2];

            nset.addElement(ix, iy, iz, dx, dy, dz, i);
        }

        /* Q 侧查询：按 invariant2 插值 */
        var nei = [];
        var seen = Object.create(null);
        var alphaCos = this.alpha;

        for (i = 0; i < pairs2.length; i++)
        {
            var c = pairs2[i][0] * 3, d = pairs2[i][1] * 3;
            var q1x = Q[c], q1y = Q[c + 1], q1z = Q[c + 2];
            var q2x = Q[d], q2y = Q[d + 1], q2z = Q[d + 2];

            var ex = q1x + this.invariant2 * (q2x - q1x);
            var ey = q1y + this.invariant2 * (q2y - q1y);
            var ez = q1z + this.invariant2 * (q2z - q1z);

            var ndx = q2x - q1x, ndy = q2y - q1y, ndz = q2z - q1z;
            var ndl = Math.sqrt(ndx * ndx + ndy * ndy + ndz * ndz);
            if (!(ndl > 1e-12)) { continue; }
            ndx /= ndl; ndy /= ndl; ndz /= ndl;

            nei.length = 0;
            var shq = this.indexShiftQ;
            nset.getNeighbors(ex + shq[0], ey + shq[1], ez + shq[2],
                              ndx, ndy, ndz, alphaCos, false, nei);

            for (var t = 0; t < nei.length; t++)
            {
                var id = nei[t];

                /* 二次校验：用 P 侧该点对按 invariant1 重算插值点，与查询点比距离 */
                var pa = pairs1[id][0] * 3, pb = pairs1[id][1] * 3;
                var vx = Q[pa] + this.invariant1 * (Q[pb] - Q[pa]);
                var vy = Q[pa + 1] + this.invariant1 * (Q[pb + 1] - Q[pa + 1]);
                var vz = Q[pa + 2] + this.invariant1 * (Q[pb + 2] - Q[pa + 2]);

                var gx = ex - vx, gy = ey - vy, gz = ez - vz;
                if (gx * gx + gy * gy + gz * gz > distThreshold * distThreshold) { continue; }

                var key = id + ':' + i;
                if (seen[key]) { continue; }
                seen[key] = 1;

                quadrilaterals.push([pairs1[id][0], pairs1[id][1], pairs2[i][0], pairs2[i][1]]);

                if (quadrilaterals.length >= maxCongruent) { return true; }
            }
        }

        return quadrilaterals.length > 0;
    };

    /* match4pcsBase.cc : Verify（LCP 打分，带增量早停） */
    Registration.prototype.verify = function (M)
    {
        /* 方向必须是 P -> Q。
         *
         * M 由 solveRigid(base(P 侧四点), quad(Q 侧四点)) 求出，语义是
         * "把 P 变换到 Q"。所以拿【P 的点】做变换、在【Q 的密集树】里查。
         *
         * 之前写成了"变换 Q 的点、在 P 树里查"，方向相反 ——
         * 只有单位阵时两个方向恰好等价，所以初始基准看着正常（54%），
         * 但任何非单位阵的候选都会被这个反向度量判成低分，永远超不过基准。
         */
        var S = this.sampledP;
        var kd = this.kdEval;          // Q 侧密集树
        var n = this.countP;
        var delta = this.deltaN;

        var terminate = this.bestLCP * n;
        var good = 0;

        for (var i = 0; i < n; i++)
        {
            var px = S[i * 3], py = S[i * 3 + 1], pz = S[i * 3 + 2];

            var tx = M[0] * px + M[1] * py + M[2] * pz + M[3];
            var ty = M[4] * px + M[5] * py + M[6] * pz + M[7];
            var tz = M[8] * px + M[9] * py + M[10] * pz + M[11];

            var cand = kd.radius(tx, ty, tz, delta, 0);
            if (cand && cand.length) { good++; }

            /* 剩余点全中也追不上当前最优 → 放弃（官方 Verify 的增量早停） */
            if (n - i + good < terminate) { break; }
        }

        return good / n;
    };

    /* match4pcsBase.hpp : TryCongruentSet
     * 对每个候选四边形：求变换 → rms < 2δ 过滤 → Verify → 更新最优 */
    Registration.prototype.tryCongruentSet = function (quads)
    {
        var Q = this.sampledQ;
        var b = this.base;
        var rmsLimit = this.distFactorN;

        var maxVerify = this.options.maxCongruent || 300;

        for (var i = 0; i < quads.length && i < maxVerify; i++)
        {
            if (this.cancelled) { return false; }

            var q = quads[i];
            var qx = [
                [Q[q[0] * 3], Q[q[0] * 3 + 1], Q[q[0] * 3 + 2]],
                [Q[q[1] * 3], Q[q[1] * 3 + 1], Q[q[1] * 3 + 2]],
                [Q[q[2] * 3], Q[q[2] * 3 + 1], Q[q[2] * 3 + 2]],
                [Q[q[3] * 3], Q[q[3] * 3 + 1], Q[q[3] * 3 + 2]]
            ];

            var M = solveRigid([
                [b[0][0], b[0][1], b[0][2], qx[0][0], qx[0][1], qx[0][2]],
                [b[1][0], b[1][1], b[1][2], qx[1][0], qx[1][1], qx[1][2]],
                [b[2][0], b[2][1], b[2][2], qx[2][0], qx[2][1], qx[2][2]],
                [b[3][0], b[3][1], b[3][2], qx[3][0], qx[3][1], qx[3][2]]
            ]);

            if (!M) { continue; }

            /* rms 门限（官方 rms < distance_factor * delta） */
            var rms = 0, r;
            for (r = 0; r < 4; r++)
            {
                var pr = b[r];
                var tx = M[0] * pr[0] + M[1] * pr[1] + M[2] * pr[2] + M[3];
                var ty = M[4] * pr[0] + M[5] * pr[1] + M[6] * pr[2] + M[7];
                var tz = M[8] * pr[0] + M[9] * pr[1] + M[10] * pr[2] + M[11];
                var dx = tx - qx[r][0], dy = ty - qx[r][1], dz = tz - qx[r][2];
                rms += dx * dx + dy * dy + dz * dz;
            }
            rms = Math.sqrt(rms / 4);
            if (!(rms < rmsLimit)) { continue; }

            this.lastStats.congruent++;
            this.diag.rmsPass++;

            var lcp = this.verify(M);
            this.lastStats.verify++;
            this.diag.verifyRun++;
            if (lcp > this.diag.lcpBest) { this.diag.lcpBest = lcp; }

            if (lcp > this.bestLCP)
            {
                this.bestTransform = M;
                this.bestPairs = q.slice();
                this.bestLCP = lcp;

                if (this.bestLCP >= this.options.terminate_threshold) { return true; }
            }
        }

        return this.bestLCP >= this.options.terminate_threshold;
    };

    /* match4pcsBase.hpp : TryOneBase —— 一次完整 RANSAC 迭代 */
    Registration.prototype.tryOneBase = function ()
    {
        if (!this.selectQuadrilateral()) { this.diag.baseFail++; return false; }

        var b = this.base;
        var dab = Math.sqrt(
            Math.pow(b[1][0] - b[0][0], 2) +
            Math.pow(b[1][1] - b[0][1], 2) +
            Math.pow(b[1][2] - b[0][2], 2));
        var dcd = Math.sqrt(
            Math.pow(b[3][0] - b[2][0], 2) +
            Math.pow(b[3][1] - b[2][1], 2) +
            Math.pow(b[3][2] - b[2][2], 2));

        if (!(dab > 1e-9) || !(dcd > 1e-9)) { return false; }

        var pairLimit = this.options.pairLimit || 20000;
        var pairs1 = this.extractPairs(dab, this.distFactorN, pairLimit);
        this.diag.pairs1 = pairs1.length;
        if (!pairs1.length) { this.diag.pairFail++; return false; }

        var pairs2 = this.extractPairs(dcd, this.distFactorN, pairLimit);
        this.diag.pairs2 = pairs2.length;
        if (!pairs2.length) { this.diag.pairFail++; return false; }

        var quads = [];
        if (!this.findCongruentQuadrilaterals(pairs1, pairs2, quads)) { return false; }

        this.diag.quads = quads.length;
        this.diag.truncated = quads.length >= (this.options.maxCongruent || 300);

        return this.tryCongruentSet(quads);
    };

    /* match4pcsBase.hpp : Perform_N_steps —— RANSAC 主循环 */
    Registration.prototype.performSteps = function (n)
    {
        var o = this.options;
        var ok = false;
        var end = Math.min(this.currentTrial + n, this.numberOfTrials);

        for (var i = this.currentTrial; i < end; i++)
        {
            ok = this.tryOneBase();

            var elapsed = (nowMs() - this.startTime) / 1000;
            var fractionTime = elapsed / Math.max(1e-6, o.max_time_seconds);
            var fractionTry = i / Math.max(1, this.numberOfTrials);
            var fraction = Math.max(fractionTime, fractionTry);

            if (ok || fraction >= 0.99 || this.bestLCP >= 1.0 || this.cancelled) { break; }
        }

        this.currentTrial = end;
        this.lastStats.quarterAndCount = this.currentTrial;

        return ok || this.currentTrial >= this.numberOfTrials;
    };

    /* 归一化坐标系下的变换 → 物理坐标系
     * 归一化： x' = (x − cP)/s ，M 作用在 x' 上得到 y' = (y − cQ)/s
     * 所以  y = s·M·x' + cQ = R·x + (cQ − R·cP)  （R 已含在 M 的 3x3 里）
     */
    Registration.prototype.toGlobal = function (Mn)
    {
        if (!Mn) { return null; }

        var s = this.scale;
        var cP = this.centroidP;
        var cQ = this.centroidQ;

        var G = new Float64Array(16);
        G[0] = Mn[0]; G[1] = Mn[1]; G[2] = Mn[2];
        G[4] = Mn[4]; G[5] = Mn[5]; G[6] = Mn[6];
        G[8] = Mn[8]; G[9] = Mn[9]; G[10] = Mn[10];
        G[12] = 0; G[13] = 0; G[14] = 0; G[15] = 1;

        /* 归一化： p' = (p − cP)/s ，  q' = (q − cQ)/s
         * 变换在归一化系： q' = R·p' + tN
         * 换回物理系：     q  = R·p + (cQ − R·cP + s·tN)
         * 其中 (cQ − R·cP) 正是"质心差补偿"，与官方 getGlobalTransform 一致。 */
        G[3] = Mn[3] * s + cQ[0] - (Mn[0] * cP[0] + Mn[1] * cP[1] + Mn[2] * cP[2]);
        G[7] = Mn[7] * s + cQ[1] - (Mn[4] * cP[0] + Mn[5] * cP[1] + Mn[6] * cP[2]);
        G[11] = Mn[11] * s + cQ[2] - (Mn[8] * cP[0] + Mn[9] * cP[1] + Mn[10] * cP[2]);

        return orthonormalize(G);
    };

    /* ================= 对外接口 ================= */

    MV.super4pcs = MV.super4pcs || {};
    MV.super4pcs.OPTION_DEFAULTS = OPTION_DEFAULTS;

    /* 分步版本：每次 step 只跑一小批，供 UI 按帧驱动 */
    MV.super4pcs.createRegistration = function (P, Q, options)
    {
        if (!P || !Q || !P.positions || !Q.positions) { return null; }
        if (P.count < 4 || Q.count < 4) { return null; }

        var reg = new Registration(P, Q, options);
        if (!reg.init()) { return null; }

        var batch = (options && options.batch) || 20;

        return {
            step: function ()
            {
                reg.performSteps(batch);

                return {
                    done: reg.cancelled || reg.currentTrial >= reg.numberOfTrials ||
                          reg.bestLCP >= reg.options.terminate_threshold,
                    progress: reg.numberOfTrials
                        ? Math.min(1, reg.currentTrial / reg.numberOfTrials) : 1,
                    trial: reg.currentTrial,
                    trials: reg.numberOfTrials,
                    lcp: reg.bestLCP,
                    matrix: (options && options.preview) ? reg.toGlobal(reg.bestTransform) : null
                };
            },

            isDone: function ()
            {
                return reg.cancelled || reg.currentTrial >= reg.numberOfTrials ||
                       reg.bestLCP >= reg.options.terminate_threshold;
            },

            cancel: function () { reg.cancelled = true; },

            result: function ()
            {
                /* bestTransform 为 null 有两种情况：
                 *   1. 一次候选都没有 —— 用单位阵名义变换（toGlobal 会补质心差）
                 *   2. 居中后两侧已经重合（LCP 初始即 1.0），此时"补偿质心差"
                 *      本身就是正确答案，不需要额外的旋转平移。 */
                /* bestTransform 为 null 时说明：搜完全部尝试，
                 * 没有候选能超过"原始位姿"的覆盖率 —— 此时直接返回单位阵，
                 * 这也是用户要求的"不如原始位姿就用原始位姿"。 */
                var usedBaseline = !reg.bestTransform;
                var Mres = reg.bestTransform || IDENT4;

                return {
                    matrix: reg.toGlobal(Mres),
                    lcp: reg.bestLCP,
                    baselineLcp: reg.baselineLCP,
                    usedBaseline: usedBaseline,
                    trial: reg.currentTrial,
                    trials: reg.numberOfTrials,
                    stats: reg.lastStats,
                    diag: reg.diag,
                    scale: reg.scale,
                    deltaN: reg.deltaN,
                    countP: reg.countP,
                    evalDense: reg.evalDense,
                    distFactorN: reg.distFactorN
                };
            }
        };
    };

    /* 同步版本：一次算完 */
    MV.super4pcs.register = function (P, Q, options)
    {
        var r = MV.super4pcs.createRegistration(P, Q, options);
        if (!r) { return null; }

        var guard = 0;
        while (!r.step().done && guard++ < 100000) { }

        var res = r.result();
        return res.matrix;
    };

}(this));
