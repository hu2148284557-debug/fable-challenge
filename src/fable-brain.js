// Fable 5.2 的打人版。
//
// 底子还是 Hybrid 的网络：每一帧它给 18 个动作各打一个分。这里只做一件事——替它把子弹看远。
// 天上的子弹之后怎么飞、怎么弹是算得准的，跟对手接下来按什么键没关系。所以每一帧先在一份
// 引擎副本里把“网络想出的这一招”往后推演：照这么走，接下来会不会被打中？会的话，按网络的
// 喜好从高到低换一招试，直到找到一招后面接得上活路的。网络想出的招本来就安全时，一个字都不改。
//
// 引擎副本用的是和正式对局同一个 kf_engine.wasm，没有改过，所以推演和真打用的是同一份物理。
// 推演里对手“按住眼下这组键不放”（Hybrid 自己躲子弹时也是这么假设的）；对手之后新开的枪算不到，
// 等它真打出来、成了天上的子弹，下一帧就能算到。
//
// 这个文件不引用任何外部模块，浏览器和 Node 都能直接用。

const STACK_END = 1 << 20; // 引擎内存的前 1MB 是调用栈，两次调用之间不用保留
const WALLS_AT = 138; // 渲染缓冲区里墙的数据从这里开始，后面跟着两辆坦克
const F_NEW_ROUND = 1;
const F_DESTROY = 16;
const F_ROUND_END = 64;
const STOP = 8; // 不动、不开火
const SLACK_BYTES = 4 << 20;
const now = () => globalThis.performance.now();

export class FableBrain {
  /**
   * @param {WebAssembly.Module} wasmModule 和正式对局同一个 kf_engine.wasm 编出来的模块
   * @param {object} options
   *   seat         她坐哪个座位（默认 0，也就是网页上对手的位置）
   *   horizon      往后推演几帧（一秒 25 帧）
   *   budgetMs     一帧最多想多少毫秒
   *   maxSteps     一帧最多推演多少步引擎（测试用，网页上用 budgetMs）
   *   wide         要不要试“两段”的走法
   *   firstKs      网络想出的那一招，先试哪几种两段接法（走几帧以后换别的走法）再考虑换招
   *   deepShare    上面这一步最多花掉多少算力（剩下的留给换招）
   *   doomedMargin 哪一招都没找到活路时，别的招要比网络想出的多活这么多帧才换
   *   freezeOpponent 对手是 Killfield 时设成 true（见 run 里的说明），别的对手一律 false
   *   instance     事先建好的引擎副本（浏览器里用异步方式建好传进来；不传就现建）
   */
  constructor(wasmModule, options = {}) {
    this.module = wasmModule;
    this.o = { seat: 0, horizon: 48, budgetMs: Infinity, maxSteps: Infinity, wide: true, doomedMargin: 1, firstKs: [1], deepShare: 0.5, freezeOpponent: false, instance: null, ...options };
    this.seat = this.o.seat;
    this.other = 1 - this.seat;
    this.sb = (this.o.instance || new WebAssembly.Instance(wasmModule, {})).exports;
    this.dst = null;
    this.plan = null; // 上一帧找到的活路：plan[f] 是这一帧起第 f 帧该出的招（第 0 帧由这一帧现定）
    this.winLine = null;
    this.winHold = STOP;
    this.round = -1;
    this.order = new Array(18);
    this.sHold = new Int16Array(18);
    this.scratch = new Uint8Array(this.o.horizon);
    this.stats = { calls: 0, quiet: 0, kept: 0, changed: 0, doomed: 0, cut: 0, steps: 0, maxSteps: 0, ms: 0, maxMs: 0, rebuilt: 0 };
    this.last = null;
  }

  newRound() {
    this.plan = null;
  }

  // ------------------------------------------------------------ 引擎副本

  // 把真实对局的内存接到副本上。真实对局那一份只读不写。
  attach(wasm) {
    const src = wasm.memory.buffer;
    const n = src.byteLength;
    let cur = this.sb.memory.buffer.byteLength;
    if (cur > n + SLACK_BYTES) {
      // 副本在推演里自己要过内存、越长越大，换一份新的。换不了（有的浏览器不许现建）就接着用旧的。
      try {
        this.sb = new WebAssembly.Instance(this.module, {}).exports;
        this.stats.rebuilt += 1;
        cur = this.sb.memory.buffer.byteLength;
      } catch { /* 接着用旧的 */ }
    }
    if (cur < n) this.sb.memory.grow((n - cur + 65535) >> 16);
    this.src = new Uint8Array(src, STACK_END, n - STACK_END);
    this.n = n;
    this.dst = null;
  }

  restore() {
    const buf = this.sb.memory.buffer;
    if (this.dst === null || this.dst.buffer !== buf) this.dst = new Uint8Array(buf, STACK_END, this.n - STACK_END);
    this.dst.set(this.src);
  }

  alive(x, handle, seat) {
    const ptr = x.kf_render_ptr(handle);
    const walls = new Float32Array(x.memory.buffer, ptr, 8)[5];
    return new Float32Array(x.memory.buffer, ptr + (WALLS_AT + walls * 4 + seat * 6 + 3) * 4, 1)[0] > 0.5;
  }

  over() {
    return this.used >= this.o.maxSteps || (this.deadline !== Infinity && now() > this.deadline);
  }

  // 从真实局面出发：第一帧出 first，之后第 f 帧出 line[f]（line 不够长就停住不动）；
  // line 是 null 时，之后一直出 hold。返回活了几帧；活满 horizon 帧，或者这一局先结束了，返回 horizon。
  run(handle, first, line, hold) {
    const sb = this.sb;
    const H = this.o.horizon;
    const seat = this.seat;
    this.restore();
    // 对手是引擎里自带规划的人机（Killfield）时，推演里把它的规划停掉：它的规划很费时间，
    // 不能每推演一步都跑一遍。注意这个开关会让引擎把那辆车的按键清空（车停住、不开火），
    // 所以只能对 Killfield 用。对人、对 Hybrid 绝不能开：测过，一开她就看不到“对手这一帧
    // 正按着开火”，对 Hybrid 的胜率从 59.1% 掉到 50.0%。
    if (this.o.freezeOpponent) sb.kf_set_mpc_enabled(handle, this.other, 0);
    let a = first;
    for (let f = 0; f < H; f += 1) {
      sb.kf_set_hybrid_action(handle, seat, a);
      const flags = sb.kf_step(handle);
      this.used += 1;
      if ((flags & F_DESTROY) && !this.alive(sb, handle, seat)) return f;
      if (flags & (F_ROUND_END | F_NEW_ROUND)) return H;
      // 对手这一帧按着的开火键，推演里只算这一下：松开它，免得之后弹药一回来又“自动”多打一发
      if (f === 0) sb.kf_set_fire_immediate(handle, this.other, 0);
      a = line !== null ? (f + 1 < line.length ? line[f + 1] : STOP) : hold;
    }
    return H;
  }

  // ------------------------------------------------------------ 每一帧

  /**
   * @param wasm 正式对局的引擎
   * @param handle 正式对局的句柄
   * @param logits Hybrid 的网络给 18 个动作打的分
   * @returns 这一帧出哪个动作（0～17）
   */
  choose(wasm, handle, logits) {
    const st = this.stats;
    st.calls += 1;
    const order = this.order;
    for (let i = 0; i < 18; i += 1) order[i] = i;
    order.sort((a, b) => logits[b] - logits[a]);
    const best = order[0];

    const ptr = wasm.kf_render_ptr(handle);
    const head = new Float32Array(wasm.memory.buffer, ptr, 16);
    if (head[9] !== this.round) {
      this.round = head[9];
      this.plan = null;
    }
    // 天上没有子弹，这一招也不开火：没有什么可算的
    if (head[7] === 0 && (best & 1) === 0) {
      st.quiet += 1;
      this.plan = null;
      this.last = null;
      return best;
    }

    const timed = this.o.budgetMs !== Infinity;
    const t0 = timed ? now() : 0;
    this.deadline = timed ? t0 + this.o.budgetMs : Infinity;
    this.attach(wasm);
    this.used = 0;
    const r = this.search(handle, order);
    st.steps += this.used;
    if (this.used > st.maxSteps) st.maxSteps = this.used;
    if (timed) {
      const ms = now() - t0;
      st.ms += ms;
      if (ms > st.maxMs) st.maxMs = ms;
    }
    if (r.pick < 0) {
      // 哪一招都没找到活路。可能是真的躲不掉，也可能只是这一帧没算完。挑活得最久的那一招。
      st.doomed += 1;
      this.plan = null;
      const pick = r.topS < r.sFirst + this.o.doomedMargin ? best : r.topA;
      this.last = { kind: "doomed", best, pick, sBest: r.sFirst };
      return pick;
    }
    if (r.pick === best) st.kept += 1; else st.changed += 1;
    this.last = { kind: r.pick === best ? "kept" : "changed", best, pick: r.pick, sBest: r.sFirst };
    return r.pick;
  }

  // 找活路，先省事后费事：
  //   A. 网络想出的这一招：照上一帧留的活路走 / 一直这么走 / 走一帧就停
  //   A2. 还是这一招：走一帧以后换成别的走法一直走。这一帧要定的只是这一帧的招，
  //       只要走完这一帧还有路可换，就不用改网络的主意。
  //   B. 换一招，按网络的喜好从高到低，各试“一直这么走”
  //   C. 各试“走一帧就停”
  //   D. 两段：先照一个走法走几帧，再换成另一个走法一直走；离活下来最近的走法先试
  // 哪一步找到了就停。算力用完也停，那时返回活得最久的那一招。
  search(handle, order) {
    const H = this.o.horizon;
    const best = order[0];
    const sHold = this.sHold;
    sHold.fill(-2);
    let pick = -1;
    let topS = -1;
    let topA = best;
    let sFirst = -1;
    const ev = (a, line, hold) => {
      const s = this.run(handle, a, line, hold);
      if (s > topS) { topS = s; topA = a; }
      if (s >= H) { this.savePlan(line, hold); pick = a; }
      return s;
    };
    const out = () => ({ pick, topS, topA, sFirst });
    const cut = () => { this.stats.cut += 1; return out(); };

    // A
    const bm = best & ~1;
    if (this.plan !== null) { ev(best, this.plan, STOP); if (pick >= 0) { sFirst = H; return out(); } }
    sHold[best] = ev(best, null, bm);
    if (pick >= 0) { sFirst = H; return out(); }
    if (bm !== STOP) { ev(best, null, STOP); if (pick >= 0) { sFirst = H; return out(); } }
    sFirst = topS;
    const line = this.scratch;

    // A2. 还是网络想出的这一招：走几帧（默认 1 帧）以后换成别的走法。最多花一部分算力。
    // 不先试这个的话，看得越远越容易因为“没试到”就以为这一招不行，白白改掉网络的主意
    // （测过：Hybrid 本来能打死人的 2809 局里，改丢的击杀从 169 局降到 96 局）。
    if (this.o.firstKs.length && this.o.wide) {
      const share = this.o.deepShare;
      const stepCap = this.o.maxSteps === Infinity ? Infinity : this.used + share * this.o.maxSteps;
      const timeCap = this.deadline === Infinity ? Infinity : this.deadline - (1 - share) * this.o.budgetMs;
      const overDeep = () => this.used >= stepCap || (timeCap !== Infinity && now() > timeCap);
      deep: for (const k of this.o.firstKs) {
        if (k >= H) break;
        if (sHold[best] >= 0 && sHold[best] < k) continue;
        for (let i = 0; i < 18; i += 1) {
          const m2 = order[i];
          if ((m2 & 1) || m2 === bm || (m2 === STOP && k === 1)) continue;
          if (overDeep()) break deep;
          line.fill(bm, 0, k);
          line.fill(m2, k);
          ev(best, line, STOP);
          if (pick >= 0) { sFirst = H; return out(); }
        }
      }
      sFirst = topS;
    }

    // B
    for (let i = 1; i < 18; i += 1) {
      const a = order[i];
      const m = a & ~1;
      // 同一个走法不开火都活不了，开火也一样活不了
      if ((a & 1) && sHold[m] > -2 && sHold[m] < H) { sHold[a] = sHold[m]; continue; }
      if (this.over()) return cut();
      sHold[a] = ev(a, null, m);
      if (pick >= 0) return this.keepFire(handle, best, out());
    }
    // C
    for (let i = 1; i < 18; i += 1) {
      const a = order[i];
      if ((a & 1) || a === STOP) continue;
      if (this.over()) return cut();
      ev(a, null, STOP);
      if (pick >= 0) return this.keepFire(handle, best, out());
    }
    if (!this.o.wide) return out();

    // D
    const byLogit = [];
    for (let i = 0; i < 18; i += 1) if ((order[i] & 1) === 0) byLogit.push(order[i]);
    const bySurvival = byLogit.slice().sort((a, b) => sHold[b] - sHold[a]);
    for (const k of [1, 4, 8, 14]) {
      if (k >= H) break;
      for (const m of bySurvival) {
        // 这个走法一直走到第 k 帧之前就已经被打中了，换不换都一样
        if (sHold[m] >= 0 && sHold[m] < k) continue;
        if (m === bm && this.o.firstKs.includes(k)) continue; // 上面 A2 试过了
        for (const m2 of byLogit) {
          if (m2 === m || (m2 === STOP && k === 1)) continue;
          if (this.over()) return cut();
          line.fill(m, 0, k);
          line.fill(m2, k);
          ev(m, line, STOP);
          if (pick >= 0) return this.keepFire(handle, best, out());
        }
      }
    }
    return out();
  }

  // 记下刚找到的活路：这次推演的第 f+1 帧，就是下一帧起的第 f 帧。
  savePlan(line, hold) {
    const H = this.o.horizon;
    const plan = new Uint8Array(H);
    for (let f = 0; f < H; f += 1) plan[f] = line !== null ? (f + 1 < line.length ? line[f + 1] : STOP) : hold;
    this.winLine = line !== null ? Uint8Array.from(line) : null;
    this.winHold = hold;
    this.plan = plan;
  }

  // 网络本来想开火、换成的这一招车头转向又没变：试试照样开火还走不走得通，走得通就不耽误这一枪。
  keepFire(handle, best, r) {
    const a = r.pick;
    if ((best & 1) === 0 || (a & 1) === 1) return r;
    if (((a >> 1) % 3) !== ((best >> 1) % 3)) return r;
    if (this.over()) return r;
    if (this.run(handle, a | 1, this.winLine, this.winHold) >= this.o.horizon) r.pick = a | 1;
    return r;
  }
}

export function argmax(logits) {
  let best = 0;
  for (let i = 1; i < logits.length; i += 1) if (logits[i] > logits[best]) best = i;
  return best;
}
