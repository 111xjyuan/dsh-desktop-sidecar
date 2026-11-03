// 判断“用户是不是正在动鼠标/打字”，以及等用户停下来。
//
// 依据：GetLastInputInfo 返回“最后一次真实输入事件”的 tick 计数（毫秒）。
// 注意它也会被我们自己注入的输入（SendInput）刷新，所以不能直接拿它当“用户在动”，
// 必须和我们自己上次操作的时间比较：只有“闲置时间比我上次动手还短”才说明中间有人动过。
import koffi from 'koffi';

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const GetTickCount64 = kernel32.func('__stdcall', 'GetTickCount64', 'uint64_t', []);
const GetLastInputInfo = user32.func('__stdcall', 'GetLastInputInfo', 'bool', ['void *']);

let lastOwnInputAt = 0;

/** 我们自己刚刚发过输入：把它记下来，免得把自己的动作当成“用户在操作”。 */
export function markOwnInput() { lastOwnInputAt = Date.now(); }

/** 距上一次真实输入过了多久（毫秒）。失败返回 -1。 */
export function idleMs() {
  const buf = Buffer.alloc(8);
  buf.writeUInt32LE(8, 0);
  try {
    if (!GetLastInputInfo(buf)) return -1;
    const dwTime = buf.readUInt32LE(4);
    const now = Number(GetTickCount64()) & 0xffffffff;
    // 32 位 tick 会回绕，按无符号减法算差值
    return ((now - dwTime) >>> 0);
  } catch {
    return -1;
  }
}

/** 用户现在是否在操作：最近 quietMs 内有输入，且那次输入不是我们自己发的。 */
export function userActive(quietMs = 700) {
  const idle = idleMs();
  if (idle < 0) return { active: false, idle: -1, source: 'unknown' };
  const sinceOwn = lastOwnInputAt ? Date.now() - lastOwnInputAt : Number.MAX_SAFE_INTEGER;
  // 闲置时间比“我上次动手”还短 ⇒ 中间有人动过
  const byUser = idle + 80 < sinceOwn;
  return { active: byUser && idle < quietMs, idle, sinceOwn, byUser };
}

/**
 * 等用户停下来再动手。
 * @returns {{ok:boolean, waited:number, idle:number, timedOut?:boolean}}
 */
export async function waitUserIdle({ quietMs = 700, maxWaitMs = 6000, pollMs = 120 } = {}) {
  const start = Date.now();
  for (;;) {
    const st = userActive(quietMs);
    if (!st.active) return { ok: true, waited: Date.now() - start, idle: st.idle };
    if (Date.now() - start >= maxWaitMs) {
      return { ok: false, timedOut: true, waited: Date.now() - start, idle: st.idle };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export const _internals = { get lastOwnInputAt() { return lastOwnInputAt; }, resetOwn() { lastOwnInputAt = 0; } };
