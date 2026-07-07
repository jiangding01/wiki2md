export function preprocessTableCells(clone: HTMLElement) {
  clone.querySelectorAll('th, td').forEach((cell) => {
    const processList = (list: HTMLElement, level: number): DocumentFragment => {
      const fragment = document.createDocumentFragment();
      if (level === 0) fragment.appendChild(document.createTextNode('{{BR}}'));

      const items = Array.from(list.children);
      items.forEach((item, index) => {
        if (item.tagName !== 'LI') return;

        let prefix = '';
        if (list.tagName === 'OL') {
          if (level === 1) prefix = `${String.fromCharCode(97 + index)}. `;
          else if (level === 2) prefix = `${['i', 'ii', 'iii', 'iv'][index] || index + 1}. `;
          else prefix = `${index + 1}. `;
        } else {
          prefix = '• ';
        }

        const indent = '&nbsp;&nbsp;&nbsp;&nbsp;'.repeat(level);
        const lineContainer = document.createElement('span');
        lineContainer.innerHTML = `${indent}${prefix}`;

        const childLists = item.querySelectorAll(':scope > ul, :scope > ol');
        const childFragments: DocumentFragment[] = [];
        childLists.forEach((childList) => {
          childFragments.push(processList(childList as HTMLElement, level + 1));
          childList.remove();
        });

        while (item.firstChild) {
          lineContainer.appendChild(item.firstChild);
        }

        fragment.appendChild(lineContainer);
        fragment.appendChild(document.createTextNode('{{BR}} '));

        childFragments.forEach((cf) => fragment.appendChild(cf));
      });

      if (level === 0) fragment.appendChild(document.createTextNode('{{BR}}'));
      return fragment;
    };

    const allLists = Array.from(cell.querySelectorAll('ul, ol'));
    const rootLists = allLists.filter((l) => {
      const parent = l.parentElement;
      return !(parent && parent.tagName === 'LI');
    });
    rootLists.forEach((list) => {
      const flatFragment = processList(list as HTMLElement, 0);
      list.replaceWith(flatFragment);
    });

    cell.querySelectorAll('ul, ol').forEach((list) => {
      while (list.firstChild) list.parentNode?.insertBefore(list.firstChild, list);
      list.remove();
    });

    cell.querySelectorAll('p, div, blockquote, h1, h2, h3, h4, h5, h6').forEach((block) => {
      if (block !== cell.firstElementChild) {
        const br = document.createElement('br');
        block.parentNode?.insertBefore(br, block);
      }
      while (block.firstChild) block.parentNode?.insertBefore(block.firstChild, block);
      block.remove();
    });

    cell.querySelectorAll('br').forEach((br) => {
      br.replaceWith(document.createTextNode('{{BR}}'));
    });

    cell.normalize();

    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, null);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (!node.nodeValue) continue;
      node.nodeValue = node.nodeValue.replace(/[\r\n]+/g, ' ');
      node.nodeValue = node.nodeValue.replace(/\|/g, '&#124;');
      node.nodeValue = node.nodeValue.replace(/({{BR}}\s*){2,}/g, '{{BR}}');
      node.nodeValue = node.nodeValue.replace(/^({{BR}}\s*)+|({{BR}}\s*)+$/g, '');
    }
  });
}

