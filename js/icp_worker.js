/* ICP / 候选验证 计算线程（Web Worker）
 *
 * 为什么单开线程：
 *   ICP 单轮实测 ~215ms、收尾轮再跑 20 轮；候选验证一次 score 4000 点 × 8 轮。
 *   全放主线程就是一串 200ms 级（首次含 JIT 达 900ms）的帧冻结，
 *   表现为"配准期间拖不动视角"。
 *   搬到 worker 后主线程只负责收进度、写一个预览 uniform，配准期间可保持 60fps。
 *
 * 4PCS 粗配准**没有**搬：pairLimit 降到 8000 后单轮只要 75ms，
 * 分散在 30 帧里无感，搬过去反而要多一次大数组传输。
 *
 * 协议（主线程 → worker）
 *   { id, cmd:'init',        fixed:{pos, nrm} }                  建 KD 并缓存（一次）
 *   { id, cmd:'solve',       moving:{pos,nrm}, opts:{...} }      跑到收敛，每轮回报 step
 *   { id, cmd:'verifyInit',  moving:{pos,nrm}, opts:{...} }      建候选验证器
 *   { id, cmd:'score',       mats:[4x4, ...] }                   逐个残差验证
 *   { id, cmd:'screen',      mats:[4x4, ...] }                   逐个命中率粗筛
 *   { id, cmd:'cancel' }
 * 协议（worker → 主线程）
 *   { id, type:'ready',  ms }                                    建树耗时
 *   { id, type:'step',   iters, rms, used, done }
 *   { id, type:'done',   mat, iters, rms, used, hasNormals }
 *   { id, type:'mats',   list:[{rms,used} | {hit,med}] }
 *   { id, type:'cancelled' } / { id, type:'error', message }
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

function doInit(msg)
{
    var t = Date.now();

    fixedPos = msg.fixed.pos;
    fixedNrm = msg.fixed.nrm || null;
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
        msg.moving.pos, msg.moving.nrm || null, fixedPos, fixedNrm, opts);

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
        msg.moving.pos, msg.moving.nrm || null, fixedPos, fixedNrm, msg.opts || {});

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
