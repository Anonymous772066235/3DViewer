/* [W·后台] worker_align.js — Super4PCS 粗配准 / ICP 精配准
 * 协议：{cmd:'coarseInit'|'coarseStep'|'init'|'solve'|'cancel', ...}
 * 依赖：core.js / algo.js（importScripts）
 */
/* core.js / algo.js 的 IIFE 都用 (window) 收尾，而 Worker 里没有 window ——
 * 把 self 挂成 window 让它们能解析（两层文件顶层都没有 document 引用）。 */
self.window = self;

var QS = location.search || '';
importScripts('core.js' + QS, 'algo.js' + QS);

var fixedPos = null;
var fixedNrm = null;
var kdFixed = null;

var cancelled = false;

function post(m)
{
    m.id = currentId;
    self.postMessage(m);
}

var currentId = 0;

self.onmessage = function (e)
{
    var msg = e.data || {};
    currentId = msg.id || 0;

    if (msg.cmd === 'cancel')
    {
        cancelled = true;
        if (activeSolver && activeSolver.cancel) { activeSolver.cancel(); }
        if (activeCoarse && activeCoarse.cancel) { activeCoarse.cancel(); }
        return;
    }

    cancelled = false;

    try
    {
        if (msg.cmd === 'coarseInit') { doCoarseInit(msg); return; }
        if (msg.cmd === 'coarseStep') { doCoarseStep(msg); return; }
        if (msg.cmd === 'init') { doInit(msg); return; }
        if (msg.cmd === 'solve') { doSolve(msg); return; }
    }
    catch (err)
    {
        post({ type: 'error', message: String((err && err.message) || err) });
    }
};

/* ---------------- Super4PCS 粗配准（无需初始位姿 / 无约束） ---------------- */
var activeCoarse = null;

function doCoarseInit(msg)
{
    if (!self.MV.super4pcs || !self.MV.super4pcs.createRegistration)
    {
        post({ type: 'error', message: 'Super4PCS 不可用' });
        return;
    }
    activeCoarse = self.MV.super4pcs.createRegistration(
        { positions: msg.moving.pos, count: msg.moving.count },
        { positions: msg.fixed.pos, count: msg.fixed.count },
        msg.opts || {});
    if (!activeCoarse)
    {
        post({ type: 'error', message: '粗配准求解器创建失败' });
        return;
    }
    post({ type: 'coarseReady' });
}

function doCoarseStep(msg)
{
    if (!activeCoarse)
    {
        post({ type: 'error', message: '尚未 coarseInit' });
        return;
    }
    if (cancelled)
    {
        post({ type: 'cancelled' });
        return;
    }
    try
    {
        var cs = activeCoarse.step();
        var out = {
            type: 'coarseStep',
            progress: cs.progress, trial: cs.trial, trials: cs.trials,
            lcp: cs.lcp, done: cs.done,
            matrix: cs.matrix ? Array.prototype.slice.call(cs.matrix) : null
        };
        if (cs.done)
        {
            var r = activeCoarse.result();
            out.result = r ? {
                matrix: r.matrix ? Array.prototype.slice.call(r.matrix) : null,
                lcp: r.lcp, usedBaseline: !!r.usedBaseline,
                baselineLcp: r.baselineLcp || 0,
                baselineMatrix: r.baselineMatrix ? Array.prototype.slice.call(r.baselineMatrix) : null,
                trial: r.trial, trials: r.trials
            } : null;
            activeCoarse = null;
        }
        post(out);
    }
    catch (err)
    {
        post({ type: 'error', message: String((err && err.message) || err) });
        activeCoarse = null;
    }
}

/* ---------------- 固定点集：只传一次，KD 只建一次 ---------------- */

function ensureKd()
{
    if (!kdFixed && fixedPos) { kdFixed = self.MV.kdtree.build(fixedPos); }
    return kdFixed;
}

/* 网格样本的法向在 Worker 内部算。computeVertexNormals 现在与 three.js 同口径：
 * 第一参数是顶点表，第二参数是面顶点索引；pos 是规范化后的顶点表。 */
function normalsOf(sample)
{
    if (!sample) { return null; }
    if (sample.nrm) { return sample.nrm; }
    if (sample.kind !== 'mesh' || !sample.pos) { return null; }
    var fn = self.MV.icp && self.MV.icp.computeVertexNormals;
    if (!fn) { return null; }
    var r = fn(sample.pos, sample.remap || null, sample.vertCount || null);
    return r.normals;
}

function doInit(msg)
{
    var t = Date.now();

    fixedPos = msg.fixed.pos;
    fixedNrm = normalsOf(msg.fixed);
    kdFixed = null;

    var kd = ensureKd();
    if (!kd) { post({ type: 'error', message: '固定点集 KD 建树失败' }); return; }

    post({ type: 'ready', ms: Date.now() - t });
}

/* ---------------- ICP 迭代 ---------------- */

var activeSolver = null;

function doSolve(msg)
{
    if (!fixedPos) { post({ type: 'error', message: '尚未 init 固定点集' }); return; }

    var kd = ensureKd();
    if (!kd) { post({ type: 'error', message: 'KD 树不可用' }); return; }

    var opts = msg.opts || {};
    opts.kd = kd;                 /* 复用缓存的全量 KD，避免每轮重建 */

    activeSolver = self.MV.icp.createSolver(
        msg.moving.pos, normalsOf(msg.moving), fixedPos, fixedNrm, opts);

    if (!activeSolver)
    {
        post({ type: 'error', message: '求解器创建失败（数据不足）' });
        return;
    }

    stepLoop();
}

function stepLoop()
{
    if (cancelled || !activeSolver)
    {
        post({ type: 'cancelled' });
        activeSolver = null;
        return;
    }

    var r = null;
    try
    {
        activeSolver.step();
        r = activeSolver.result();
    }
    catch (err)
    {
        post({ type: 'error', message: String((err && err.message) || err) });
        activeSolver = null;
        return;
    }

    var done = activeSolver.isDone();

    /* 带上当前矩阵：主线程要用它写 GPU 预览（只改一个 uniform，不做顶点拷贝） */
    post({
        type: 'step',
        iters: r.iters, rms: r.rms, used: r.used, done: done,
        mat: Array.prototype.slice.call(r.mat)
    });

    if (done)
    {
        post({
            type: 'done',
            mat: Array.prototype.slice.call(r.mat),
            iters: r.iters,
            rms: r.rms,
            used: r.used,
            hasNormals: r.hasNormals
        });
        activeSolver = null;
        return;
    }

    /* 让出一拍：Worker 的事件循环必须能转起来，否则收不到 cancel */
    setTimeout(stepLoop, 0);
}

