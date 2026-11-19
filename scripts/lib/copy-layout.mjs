// Pass an isolated Playwright page already navigated to the feature's relevant state.
export async function measureCopy(page, rules) {
  if (!rules.length) throw new Error('Provide at least one copy selector.');
  await page.evaluate(() => document.fonts.ready);
  const results = [];
  for (const { selector, maxLines = 2, reason } of rules) {
    if (!Number.isInteger(maxLines) || maxLines < 1) throw new Error('maxLines must be a positive integer.');
    if (maxLines > 2 && !reason?.trim()) throw new Error('Explain exceptions above two lines.');
    const rows = await page.locator(selector).evaluateAll(nodes => nodes.map(el => {
      const css = getComputedStyle(el), box = el.getBoundingClientRect();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const rects = [];
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        rects.push(...[...range.getClientRects()].filter(r => r.width > 0 && r.height > 0));
      }
      // Inline emphasis and links can contribute multiple rectangles to the same line.
      const tops = [];
      for (const r of rects.sort((a, b) => a.top - b.top)) {
        if (!tops.some(top => Math.abs(top - r.top) <= 1)) tops.push(r.top);
      }
      const text = el.textContent.trim();
      const visible = box.width > 0 && box.height > 0 && css.visibility !== 'hidden' && css.visibility !== 'collapse' && css.opacity !== '0';
      const overflowX = (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) || rects.some(r => r.right > box.right + 1 || r.left < box.left - 1);
      const overflowY = (el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 1) || rects.some(r => r.bottom > box.bottom + 1);
      return {
        text, characters: [...text].length, lines: tops.length, visible,
        width: box.width, height: box.height,
        contentWidth: (el.clientWidth || box.width) - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight),
        font: css.fontFamily, fontSize: css.fontSize, lineHeight: css.lineHeight,
        overflowX, overflowY
      };
    }));
    results.push({ selector, maxLines, ...(reason ? { reason } : {}), rows });
  }
  const failures = results.flatMap(({ selector, maxLines, rows }) => {
    if (!rows.length) return [{ selector, problem: 'No matching elements' }];
    return rows.flatMap((row, index) => {
      const problems = [];
      if (!row.visible) problems.push('Hidden element');
      if (!row.text || !row.lines) problems.push('No rendered text');
      if (row.lines > maxLines) problems.push(`${row.lines} lines exceeds ${maxLines}`);
      if (row.overflowX || row.overflowY) problems.push('Text overflows or is clipped');
      return problems.map(problem => ({ selector, index, text: row.text, problem }));
    });
  });
  return { viewport: page.viewportSize(), results, failures, passed: failures.length === 0 };
}
