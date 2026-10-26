// 批量动作执行器：一次工具调用跑多步，把往返次数从 N 降到 1。
// 安全设计：dryRun 只校验不执行；stopOnError 默认 true；步骤数上限；
// 每步开始前检查 Esc（用户随时可以按 Esc 中止）。
const DEFAULT_MAX = 24;

export async function runSequence({ steps, dryRun = false, stopOnError = true, maxSteps = DEFAULT_MAX, primitives }) {
  const list = Array.isArray(steps) ? steps : [];
  if (list.length === 0) throw new Error('steps must be a non-empty array');
  const limit = Math.max(1, Math.min(Number(maxSteps) || DEFAULT_MAX, DEFAULT_MAX));
  if (list.length > limit) throw new Error(`too many steps: ${list.length} > maxSteps ${limit}`);

  const log = [];
  let cancelled = false;
  const t0 = Date.now();

  for (let i = 0; i < list.length; i++) {
    const step = list[i] || {};
    const action = String(step.action || '').toLowerCase();
    const rec = { i, action, ok: false };
    try {
      if (primitives.cancelled && primitives.cancelled()) {
        cancelled = true;
        rec.ok = false; rec.error = 'cancelled by Esc';
        log.push(rec);
        break;
      }
      if (dryRun) {
        rec.ok = true; rec.dryRun = true;
        rec.would = describe(action, step);
        log.push(rec);
        continue;
      }
      const t = Date.now();
      const res = await primitives.exec(action, step, { index: i, total: list.length });
      rec.ok = !(res && res.ok === false);
      rec.ms = Date.now() - t;
      if (res && typeof res === 'object') {
        for (const k of ['changed', 'changedPx', 'via', 'text', 'at', 'matched', 'control', 'error', 'lines', 'path', 'note']) {
          if (res[k] !== undefined) rec[k] = res[k];
        }
      }
      log.push(rec);
      if (!rec.ok && stopOnError) {
        rec.stopped = true;
        break;
      }
      if (step.waitAfter) await primitives.sleep(Number(step.waitAfter));
    } catch (e) {
      rec.ok = false;
      rec.error = String((e && e.message) || e);
      log.push(rec);
      if (stopOnError) { rec.stopped = true; break; }
    }
  }

  const failed = log.filter((x) => x.ok === false && !x.dryRun).length;
  return {
    ok: !cancelled && failed === 0,
    executed: log.filter((x) => !x.dryRun).length,
    planned: list.length,
    failed, cancelled,
    dryRun: !!dryRun,
    ms: Date.now() - t0,
    log,
    hint: cancelled
      ? '用户按了 Esc，已中止。'
      : failed ? '有步骤失败：看 log 里的 error / changed=false，必要时先用 desktop_tree 或 desktop_read 确认目标。' : undefined,
  };
}

function describe(action, step) {
  switch (action) {
    case 'click': return step.text ? `click text "${step.text}"` : step.control !== undefined ? `click control #${step.control}` : `click (${step.x ?? 'fx' + step.fx},${step.y ?? 'fy' + step.fy})`;
    case 'type': return `type ${String(step.text ?? '').length} chars${step.submit ? ' + Enter' : ''}`;
    case 'key': return `press ${step.key}`;
    case 'scroll': return `scroll ${step.clicks ?? step.amount ?? 3}${step.direction ? ' ' + step.direction : ''}`;
    case 'wait': return `wait ${step.ms ?? 300}ms`;
    case 'focus': return 'focus window';
    case 'read': return 'read OCR text';
    case 'screenshot': return 'capture screenshot';
    default: return action || '(missing action)';
  }
}
