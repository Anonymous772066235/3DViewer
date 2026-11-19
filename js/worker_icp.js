/* [W·后台] worker_icp.js — 配准迭代 / 候选验证
 * 协议：{cmd:'init'|'solve'|'verifyInit'|'score'|'cancel', ...}
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

var verifier = null;
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
        return;
    }

    cancelled = false;

    try
    {
        if (msg.cmd === 'init') { doInit(msg); return; }
        if (msg.cmd === 'solve') { doSolve(msg); return; }
        if (msg.cmd === 'verifyInit') { doVerifyInit(msg); return; }
        if (msg.cmd === 'score') { doScore(msg); return; }
        if (msg.cmd === 'screen') { doScreen(msg); return; }
    }
    catch (err)
    {
        post({ type: 'error', message: String((err && err.message) || err) });
    }
};

/* ---------------- 固定点集：只传一次，KD 只建一次 ---------------- */

function ensureKd()
{
    if (!kdFixed && fixedPos) { kdFixed = self.MV.kdtree.build(fixedPos); }
    return kdFixed;
}

/* 网格样本的法向在 Worker 内部算（主线程只传 positions/remap/vertCount），
 * 避免主线程每次配准都跑一遍 O(面数) 的 computeVertexNormals。
 * 点云样本自带 normals（或从 positions 直接来），不需要重算。 */
function normalsOf(sample)
{
    if (!sample) { return null; }
    if (sample.nrm) { return sample.nrm; }
    if (sample.kind !== 'mesh' || !sample.positions) { return null; }
    var fn = self.MV.icp && self.MV.icp.computeVertexNormals;
    if (!fn) { return null; }
    var r = fn(sample.positions, sample.remap || null, sample.vertCount || null);
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

/* ---------------- 候选验证器 ---------------- */

function doVerifyInit(msg)
{
    if (!fixedPos) { post({ type: 'error', message: '尚未 init 固定点集' }); return; }

    verifier = self.MV.icp.createVerifier(
        msg.moving.pos, normalsOf(msg.moving), fixedPos, fixedNrm, msg.opts || {});

    if (!verifier) { post({ type: 'error', message: '验证器创建失败' }); return; }

    post({ type: 'ready', ms: 0 });
}

function doScore(msg)
{
    if (!verifier) { post({ type: 'error', message: '尚未 verifyInit' }); return; }

    var mats = msg.mats || [];
    var out = [];

    for (var i = 0; i < mats.length; i++)
    {
        if (cancelled) { post({ type: 'cancelled' }); return; }

        var sc = verifier.score(mats[i]);
        out.push({ rms: sc.rms, used: sc.used });
    }

    post({ type: 'mats', list: out });
}

function doScreen(msg)
{
    if (!verifier) { post({ type: 'error', message: '尚未 verifyInit' }); return; }

    var mats = msg.mats || [];
    var out = [];

    for (var i = 0; i < mats.length; i++)
    {
        if (cancelled) { post({ type: 'cancelled' }); return; }

        var sn = verifier.screen(mats[i]);
        out.push({ hit: sn.hit, med: sn.med });
    }

    post({ type: 'mats', list: out });
}
