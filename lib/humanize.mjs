// 把内部错误翻译成“人话 + 下一步”。
//
// 背景：以前报错是写给开发看的（blocked:'POINT_COVERED'、uia.ps1 cannot be parsed…），
// 用户看不懂就只会说“用不了”。这里统一翻译成三句话：发生了什么、为什么会这样、你现在该做什么。
// 原则：不承诺做不到的事；能自己处理的说“我会重试”，需要用户动手的写得像说明书。

const RULES = [
  {
    test: (o) => o.blocked === 'user-active',
    title: '你正在用鼠标键盘，它先停手了',
    what: '它没有抢你的鼠标键盘。',
    why: '这是故意的：你操作的时候它插进来只会更乱。',
    todo: '你停下来一两秒它就会继续；想让它别等，可以传 yieldToUser:false。',
    needFromUser: null,
  },
  {
    test: (o) => o.blocked === 'focus' || /cannot take text|blockedBy/i.test(String(o.error || '')),
    title: '这次没把字打进输入框',
    what: '它点到的位置不是能写字的地方，所以没有硬发按键。',
    why: '多半是点在按钮/列表上，或者这个软件是自绘界面、系统读不出输入框在哪。',
    todo: '先 desktop_look 看一眼，再用 ref 或 name 指定具体的输入框；实在找不到就用看图 + 坐标点一次，再单独 desktop_type。',
    needFromUser: '需要你确认一下要打字的那个框在哪（截图里框一下也行）。',
  },
  {
    test: (o) => /POINT_COVERED/.test(String(o.blocked || '')) || /covers? that point/i.test(String(o.error || '')),
    title: '要点的位置被别的窗口挡住了',
    what: '它发现落点上面盖着另一个程序，所以没有点下去。',
    why: '点下去会点到别人身上——宁可不动，也不乱点。',
    todo: '把那个窗口挪开/关掉，或者干脆让它在后台点（传 force:true 只在你确定安全时用）。',
    needFromUser: null,
  },
  {
    test: (o) => /minimized/i.test(String(o.blocked || '') + String(o.error || '')),
    title: '这个窗口是最小化的',
    what: '最小化的窗口拍不到、也点不到，所以它没有擅自帮你还原。',
    why: '还原会改变你的窗口状态，它默认不动。',
    todo: '传 restoreWindow:true 让它先还原；或者你自己点开任务栏那个窗口。',
    needFromUser: null,
  },
  {
    test: (o) => /secure desktop|锁屏|locked/i.test(String(o.error || '') + String(o.blocked || '')),
    title: '系统当前在安全桌面（锁屏 / UAC 授权框）',
    what: '这个界面下任何自动化都不能操作。',
    why: 'Windows 的安全边界，不是插件的问题，也不应该绕过。',
    todo: '先把屏幕解锁，或者手动点掉那个授权框，然后重试。',
    needFromUser: '需要你解锁屏幕或手动处理那个系统弹窗。',
  },
  {
    test: (o) => /uia\.ps1 cannot be parsed|ParseFile|语法/i.test(String(o.error || '')),
    title: '系统的 PowerShell 没法运行插件的脚本',
    what: '读控件文字这条路断了，但截图、点击、打字还能用。',
    why: '常见原因：执行策略被公司锁死、杀毒软件拦脚本、PowerShell 被精简掉。',
    todo: '先跑 desktop_doctor{report:true} 生成体检报告；如果是执行策略，用管理员 PowerShell 执行 Set-ExecutionPolicy -Scope CurrentUser RemoteSigned。',
    needFromUser: '需要你把体检报告发给我，或者按提示改一下系统设置。',
  },
  {
    test: (o) => /not available any more|stale|no longer exists|window handle/i.test(String(o.error || '') + String(o.hint || '')),
    title: '这个窗口已经不在了',
    what: '刚才那个窗口被关掉或换掉了，原来的编号失效。',
    why: '窗口编号只在它存在期间有效；程序重启、切了标签页都会变。',
    todo: '重新 desktop_windows 或 desktop_look 拿一个新编号再操作；它也会尽量按窗口名自己找回来。',
    needFromUser: null,
  },
  {
    test: (o) => /no such file|ENOENT|not found/i.test(String(o.error || '')),
    title: '没找到这个程序',
    what: '按你给的名字在这台机器上找不到可执行的程序。',
    why: '可能是名字不对、装在别的盘、或者这是要打开的文件而不是程序。',
    todo: '它会同时返回几个候选路径，挑一个再试；也可以直接给完整路径。',
    needFromUser: null,
  },
  {
    test: (o) => /EPERM|EACCES/i.test(String(o.error || '') + String(o.code || '')),
    title: '系统拒绝了这次操作',
    what: '权限不够或者被安全软件拦住了。',
    why: '对方程序可能以管理员身份运行，而插件没有管理员权限。',
    todo: '要么用管理员身份重开 DSH，要么对这个程序改为手动操作。',
    needFromUser: '需要你决定是否用管理员身份运行 DSH。',
  },
  {
    test: (o) => /elevat|管理员权限运行/i.test(String(o.error || '') + String(o.hint || '')),
    title: '目标程序是管理员权限，插件够不着',
    what: 'Windows 不允许普通程序向高权限窗口发按键。',
    why: '系统级防护，绕过去等于开后门，不做。',
    todo: '重要操作请用管理员身份重开 DSH；日常软件不用管这一条。',
    needFromUser: '需要你决定是否用管理员身份运行 DSH。',
  },
  {
    test: (o) => /timeout|超时/i.test(String(o.error || '')),
    title: '等太久，先停了',
    what: '在规定时间里没等到窗口出现/页面变化。',
    why: '程序启动慢、网络慢，或者这一步本来就没生效。',
    todo: '加大 timeoutMs 再试；网页类可以先用 desktop_web 的内置浏览器（更快）。',
    needFromUser: null,
  },
  {
    test: (o) => o.blocked === 'protected-window' || /protected/i.test(String(o.blocked || '')),
    title: '这是系统保护的对话框，模拟鼠标点不动',
    what: '像「打开方式」「选择应用」这类窗口不接收模拟点击。',
    why: 'Windows 把它们放在更高层，普通程序只能看、不能点。',
    todo: '用键盘：Tab 移焦点、回车确认、Esc 取消（desktop_key 支持）。',
    needFromUser: null,
  },
];

/**
 * @param {{ok?: boolean, error?: string, blocked?: string, code?: string, hint?: string}} out
 * @returns {{title: string, what: string, why: string, todo: string, needFromUser: string|null}|null}
 */
export function explain(out) {
  if (!out || typeof out !== 'object') return null;
  if (out.ok !== false && !out.blocked && !out.verifyFailed) return null;
  const probe = { ...out, error: String(out.error || ''), blocked: String(out.blocked || '') };
  for (const r of RULES) {
    try { if (r.test(probe)) return { title: r.title, what: r.what, why: r.why, todo: r.todo, needFromUser: r.needFromUser || null }; } catch {}
  }
  return null;
}

/** 一行话，给 HUD 用（≤ 22 字，屏幕右下角放得下）。 */
export function shortNotice(ex) {
  if (!ex) return null;
  if (ex.needFromUser) return '需要你：' + String(ex.needFromUser).replace(/^需要你/, '').slice(0, 18);
  return ex.title.slice(0, 22);
}
