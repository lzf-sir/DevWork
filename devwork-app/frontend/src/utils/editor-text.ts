/**
 * 编辑区 DOM → 纯文本。
 *
 * 为什么不用 `innerText`：它按**渲染结果**推断换行。空行渲染成 `<div><br></div>`，
 * innerText 会把 div 的断行和 br 的断行都算一次 —— 19 行的文件给出 25 行，
 * 于是「改一个字保存」会给文件塞进 6 个空行。而不放 br 的话，空行在
 * contentEditable 里点不进去（高度为 0），用户没法在空行处输入。
 *
 * 按结构取就没有这个问题：顶层子元素天然一一对应行号，`<br>` 只在**行内**
 * 当软换行处理。唯一例外是「只有一个 br 的行」——那是占位符，不是换行。
 */

/** 行内文本：`<br>` 是软换行，其余按文本节点拼接。 */
function inlineText(el: HTMLElement): string {
  let out = '';
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? '';
      return;
    }
    if (node.nodeName === 'BR') {
      out += '\n';
      return;
    }
    node.childNodes.forEach(walk);
  };
  el.childNodes.forEach(walk);
  return out;
}

/** `<div><br></div>` = 空行占位：br 在这里只负责撑行高，不表示换行。 */
function isPlaceholderLine(el: HTMLElement): boolean {
  return el.childNodes.length === 1 && el.firstChild?.nodeName === 'BR';
}

export function serializeEditor(root: HTMLElement | null): string {
  if (!root) return '';
  const lines: string[] = [];
  for (const child of Array.from(root.childNodes)) {
    /* 裸文本节点：拖拽或粘贴后浏览器偶尔会在行之间留下半截文本，
     * 直接丢掉就等于静默删内容，所以按行收进去。 */
    if (child.nodeType === Node.TEXT_NODE) {
      lines.push(child.nodeValue ?? '');
      continue;
    }
    if (!(child instanceof HTMLElement)) continue;
    lines.push(isPlaceholderLine(child) ? '' : inlineText(child));
  }
  return lines.join('\n');
}
