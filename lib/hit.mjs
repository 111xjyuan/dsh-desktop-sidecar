// 命中测试的分类规则（纯函数，方便单测）。
//
// 背景：Chromium 常把整页/整层做成一个带 Invoke 的 Group，或者把页面主体做成
// 覆盖几乎整个客户区的 Pane。如果照着“能点就吸附”的规则，点击就会被送到页面正中
// —— 那正是用户抱怨的“点空白”。所以这里把规则写死成三条闸：
//   1) 只有真控件角色才吸附（Button/CheckBox/…/Edit）
//   2) 控件不能大到像容器（超过客户区 20% 就不吸附）
//   3) 容器（超过客户区 45%）一律不吸附
// 另外：Document/Edit 这类文本区是“点进去插光标”的合法目标，不能报空白。

export const CONTROL_ROLES = /^(Button|CheckBox|RadioButton|TabItem|Tab|Hyperlink|Link|ListItem|MenuItem|SplitButton|ComboBox|TreeItem|DataItem|Slider|Spinner|Edit)$/i;
export const INTERACTIVE_PATTERNS = /^(Invoke|Toggle|SelectionItem|ExpandCollapse)$/;
export const TEXT_PATTERNS = /^(Text|Value|TextPattern)$/;
export const CONTAINER_ROLES = /^(Pane|Window|Group|Custom|Text)$/i;

/**
 * @param {{role?:string, patterns?:string[], rect?:{x:number,y:number,w:number,h:number}, clickable?:{x:number,y:number}}} hit
 * @param {number} refArea 参考面积（客户区或整屏），用来判断“大块”“容器”“空白”
 * @returns {{area:number,interactive:boolean,controlRole:boolean,textArea:boolean,tiny:boolean,container:boolean,smallEnough:boolean,blank:boolean,snap:null|{x:number,y:number}}}
 */
export function classifyHit(hit, refArea) {
  const r = {
    area: 0, interactive: false, controlRole: false, textArea: false,
    tiny: false, container: false, smallEnough: true, blank: false, snap: null,
  };
  if (!hit || !hit.role) return r;
  const role = String(hit.role);
  const pats = (Array.isArray(hit.patterns) ? hit.patterns : []).map(String);
  r.interactive = pats.some((p) => INTERACTIVE_PATTERNS.test(p));
  r.textArea = role === 'Document' || role === 'Edit' || pats.some((p) => TEXT_PATTERNS.test(p));
  r.controlRole = CONTROL_ROLES.test(role);
  r.area = hit.rect ? Math.max(0, Number(hit.rect.w) || 0) * Math.max(0, Number(hit.rect.h) || 0) : 0;
  r.tiny = !!(hit.rect && (Number(hit.rect.w) <= 4 || Number(hit.rect.h) <= 4));
  const area = Number(refArea) || 0;
  r.container = !!(area && r.area >= area * 0.45);
  r.smallEnough = !area || r.area <= area * 0.2;

  const canSnap = r.interactive && r.controlRole && r.smallEnough && !r.tiny && !r.container && !!hit.clickable;
  if (canSnap) {
    r.snap = { x: Number(hit.clickable.x), y: Number(hit.clickable.y) };
  } else if (!r.textArea && (r.container || CONTAINER_ROLES.test(role))) {
    // 只有“几乎整块都是它”才算空白；半大不小的容器只标 container。
    r.blank = !!(area && r.area >= area * 0.85);
  }
  return r;
}

/** 同一个点上的“后补点击”是否值得做：只对真控件、非容器。 */
export function worthRetry(hit) {
  if (!hit || !hit.clickable || !hit.role) return false;
  if (hit.container === true) return false;
  return CONTROL_ROLES.test(String(hit.role)) && !/^(Document|Edit)$/i.test(String(hit.role));
}
