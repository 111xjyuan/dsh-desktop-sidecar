/**
 * dsh-desktop-sidecar 的界面半边 —— 右侧栏「指挥台」。
 *
 * 干什么：长任务跑到一半你想改方向，就在这儿写一句、点发送（或 Ctrl+Enter）。
 * 句子写进 steer.txt，宿主那半边（lib/steer.mjs）在每一步之间读，读到就停下手上的活，
 * 按你说的改，然后继续。
 *
 * 为什么不用聊天框：模型跑一轮任务时看不到你新发的消息，只有落到磁盘上的文件才来得及。
 *
 * ⚠️ 整个模块包在 IIFE 里（DSH 把所有客户端插件拼成一个脚本，顶层 const 会撞名）。
 */
;(() => {
  const TAB_KIND = 'steer'
  const TAB_ID = 'dsh-desktop-sidecar:steer'
  const ROUTE = '/dsh-sidecar/steer'

  window.__ModuleLoader__.load({
    id: 'dsh-desktop-sidecar',
    factory: (require) => {
      const React = require('react')
      const h = React.createElement
      const module = { exports: {} }
      const exports = module.exports

      const C = {
        bg: 'var(--dsw-alias-bg-base)',
        border: 'var(--dsw-alias-border-l1)',
        text: 'var(--dsw-alias-label-primary)',
        sub: 'var(--dsw-alias-label-secondary)',
        accent: 'var(--dsw-alias-brand-primary)',
      }

      function SteerPanel() {
        const [text, setText] = React.useState('')
        const [msg, setMsg] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const [last, setLast] = React.useState('')

        React.useEffect(() => {
          let alive = true
          fetch(ROUTE)
            .then((r) => r.json())
            .then((d) => { if (alive && d && d.ok) setLast(String(d.command || '')) })
            .catch(() => {})
          return () => { alive = false }
        }, [])

        async function send() {
          const v = String(text || '').trim()
          if (!v || busy) return
          setBusy(true)
          try {
            const r = await fetch(ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ command: v }),
            })
            const d = await r.json()
            if (d && d.ok) {
              setText('')
              setLast(v)
              setMsg('已交给它，下一步就会看到')
            } else {
              setMsg('没发出去：' + String((d && d.error) || '未知原因'))
            }
          } catch (e) {
            setMsg('连不上插件：' + String((e && e.message) || e))
          } finally {
            setBusy(false)
          }
        }

        function onKey(e) {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send() }
        }

        return h(
          'div',
          { style: { padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, height: '100%', boxSizing: 'border-box', color: C.text } },
          h('div', { style: { fontSize: 12.5, color: C.sub, lineHeight: 1.5 } },
            '它正在操作电脑时，你在这儿写一句，它下一步就会停下来照你说的改。'),
          h('textarea', {
            value: text,
            onChange: (e) => { setText(e.target.value); if (msg) setMsg('') },
            onKeyDown: onKey,
            placeholder: '比如：第 3 题漏了，先补上再往下',
            rows: 4,
            style: {
              width: '100%', boxSizing: 'border-box', resize: 'vertical', minHeight: 76,
              padding: '8px 10px', fontSize: 13, lineHeight: 1.55, color: C.text,
              background: 'var(--dsw-alias-bg-elevated, transparent)',
              border: '1px solid ' + C.border, borderRadius: 8, outline: 'none', fontFamily: 'inherit',
            },
          }),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('button', {
              onClick: send,
              disabled: busy || !String(text || '').trim(),
              style: {
                height: 30, padding: '0 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
                fontSize: 13, fontWeight: 600,
                background: busy || !String(text || '').trim() ? 'var(--dsw-alias-border-l1)' : C.accent,
                color: busy || !String(text || '').trim() ? C.sub : '#fff',
              },
            }, busy ? '发送中…' : '发送'),
            h('span', { style: { fontSize: 12, color: C.sub } }, 'Ctrl+Enter'),
          ),
          msg ? h('div', { style: { fontSize: 12, color: msg.startsWith('已') ? C.accent : '#e5534b' } }, msg) : null,
          last ? h('div', { style: { fontSize: 11.5, color: C.sub, borderTop: '1px solid ' + C.border, paddingTop: 8, lineHeight: 1.5 } },
            '上一条：', h('span', { style: { color: C.text } }, last)) : null,
        )
      }

      function SteerTitle() {
        return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
          h('span', { 'aria-hidden': 'true' }, '🎯'), h('span', null, '指挥台'))
      }

      const inject = ['slots', 'sidebarRightTabs']

      function apply(ctx) {
        try {
          ctx.inject(['sidebarRightTabs'], (scoped) => {
            const tabs = typeof scoped.get === 'function' ? scoped.get('sidebarRightTabs') : scoped.sidebarRightTabs
            if (!tabs || typeof tabs.register !== 'function') return
            tabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              keepMounted: true,
              priority: 'extension',
              title: () => '指挥台',
              guide: [{
                id: TAB_KIND,
                order: 160,
                title: () => '指挥台',
                description: '随时插话，让它按你说的改',
              }],
            })
          })
        } catch (e) {}
        // 自动开合：插件正在操作电脑时把「指挥台」摆出来，停手就收回去
        try {
          ctx.inject(['sidebarRight'], (scoped) => {
            const sr = typeof scoped.get === 'function' ? scoped.get('sidebarRight') : scoped.sidebarRight
            if (!sr || typeof sr.openTab !== 'function') return
            let opened = null
            let openedAt = 0
            let absent = 0
            let timer = null
            const idOf = () => {
              try {
                const a = sr.active()
                return a && (a.id || a.tabId) || null
              } catch (e) { return null }
            }
            const tick = () => {
              // 开合判断交给服务端（lib/panel.mjs）：这里只上报“我开着没、开了多久、连续空了几次”。
              // 以前客户端看到 active=false 就立刻收，两次工具调用之间的思考时间就会让它一闪一收。
              const qs = '?open=' + (opened === null ? '0' : '1') + '&openedAt=' + openedAt + '&absent=' + absent
              fetch('/dsh-sidecar/active' + qs, { headers: { accept: 'application/json' } })
                .then((r) => r.json())
                .then((j) => {
                  const action = j && j.action ? j.action : (j && j.active ? 'open' : 'keep')
                  if (!j || !j.active) absent += 1; else absent = 0
                  if (action === 'open' && opened === null) {
                    try { sr.openTab(TAB_KIND) } catch (e) { return }
                    opened = idOf() || 'pending'
                    openedAt = Date.now()
                    absent = 0
                  } else if (action === 'close' && opened !== null) {
                    const id = opened === 'pending' ? idOf() : opened
                    try { if (id) sr.close(id) } catch (e) {}
                    opened = null
                    openedAt = 0
                    absent = 0
                  }
                })
                .catch(() => {})
            }
            timer = setInterval(tick, 900)
            tick()
            return () => { if (timer) clearInterval(timer) }
          })
        } catch (e) {}
        try {
          ctx.inject(['slots'], (scoped) => {
            scoped.slots.inject('sidebar.right.pane.tab', () =>
              scoped.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, () => h(SteerPanel)))
            scoped.slots.inject('sidebar.right.pane.tab.title', () =>
              scoped.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, SteerTitle))
          })
        } catch (e) {}
      }

      exports.inject = inject
      exports.apply = apply
      return module.exports
    },
  })
})()
