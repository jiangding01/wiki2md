/**
 * 摘墨 · 飞书 docx 接口化采集
 *
 * 数据通道：GET /space/api/docx/pages/client_vars?id=<docx_token>&mode=7&limit=N[&cursor=...]
 * （渲染页面自身使用的同源接口，浏览器自动携带登录态，插件不接触任何凭证）。
 * 响应为 { code:0, data:{ block_map, has_more, cursor, next_cursors, id } }：
 * block_map 是「块 id → 块数据」的平面字典，块之间靠 parent_id/children 组成树；
 * 长文档分多个 chunk 下发，cursor / next_cursors 是后续 chunk 的不透明游标。
 *
 * 正文文本是 EtherPad easysync 编码：
 *   text.initialAttributedTexts.text["0"]     纯文本（多行块内含 \n）
 *   text.initialAttributedTexts.attribs["0"]  属性操作串，如 "*0*1+9|2+5"
 *     *N   把 apool.numToAttrib[N]（base36）压入当前属性集
 *     |L   接下来的片段横跨 L 行（对提取无影响，跳过）
 *     +C   当前属性集应用到接下来 C（base36）个字符，随后属性集清空
 *
 * 本文件只负责「接口 → 规范化 DOM」，被 feishu.js 优先调用；
 * 任何一步失败都抛错，由 feishu.js 回退到滚动采集，绝不让用户空手而归。
 */

// 幂等声明：重复注入时复用首次实例（const 重声明会抛错；裸 var 重建会清空注册表等内部状态）
var InkFeishuDocx = window.InkFeishuDocx || {

  /** 每个 chunk 请求的块数上限；线上首屏实测一个 chunk 约 240 块 */
  CHUNK_LIMIT: 500,
  /** 分页安全上限：120 chunk × ~240 块 ≈ 3 万块，超出则截断并告警 */
  MAX_CHUNKS: 120,
  /** chunk 并发拉取数（对源站保持克制） */
  FETCH_CONCURRENCY: 3,

  /**
   * 从 DOM 拿 docx token：正文根块携带 data-record-id（隔离世界可读 DOM，
   * 但读不到页面 JS 变量，所以不能用 window.DATA）。
   * wiki 页面 URL 里是 wiki_token 而非文档 token，必须走 DOM 这条路。
   */
  docToken() {
    const el = document.querySelector('[data-block-type="page"][data-record-id]');
    if (el && el.getAttribute('data-record-id')) return el.getAttribute('data-record-id');
    const m = location.pathname.match(/\/docx\/([A-Za-z0-9]+)/);
    return m ? m[1] : null;
  },

  /** 接口化提取主入口：token → IR（失败抛错，调用方负责回退） */
  async extract(token, opts) {
    const { blockMap, truncated } = await this.fetchAllBlocks(token);
    let rootId = blockMap[token] ? token : null;
    if (!rootId) {
      rootId = Object.keys(blockMap).find(id =>
        blockMap[id] && blockMap[id].data && blockMap[id].data.type === 'page');
    }
    if (!rootId) throw new Error('接口数据中未找到页面根块');

    const warnings = [];
    if (truncated) {
      warnings.push(`文档超过 ${this.MAX_CHUNKS} 个数据分片，已截断采集，导出可能不完整。`);
    }

    const report = { missing: 0, unsupported: {}, commentIds: [], _seenComments: new Set() };
    // 全文评论挂在 page 根块上，划线评论挂在具体 block 上——根块也要收
    this._collectCommentIds(blockMap[rootId].data, report);
    const container = document.createElement('div');
    this._renderChildren(blockMap[rootId].data.children || [], blockMap, container, report);

    if (report.missing > 0) {
      warnings.push(`有 ${report.missing} 个内容块未在接口数据中返回，对应位置可能缺失。`);
    }
    const unsupported = Object.entries(report.unsupported);
    if (unsupported.length) {
      warnings.push('以下类型的块暂不支持精确导出，已插入占位说明：' +
        unsupported.map(([label, n]) => `${label} × ${n}`).join('、') + '。');
    }

    InkIR.normalizeContainer(container);

    const ir = InkIR.create({
      title: this._plain(blockMap[rootId].data.text) ||
        InkIR.pickTitle(null, /\s*[-–]\s*(飞书云文档|飞书|Feishu Docs|Lark Docs).*$/i),
      siteName: '飞书文档',
      contentEl: container,
      warnings,
    });

    if ((!opts || opts.includeComments !== false) && report.commentIds.length) {
      try {
        ir.annotations = await this._fetchComments(token, report.commentIds);
      } catch (e) {
        ir.warnings.push('评论拉取失败（' + (e.message || e) + '），仅导出正文。');
      }
    }
    return ir;
  },

  /* ---------- 分页拉取 ---------- */

  async fetchAllBlocks(token) {
    const blockMap = {};
    const seen = new Set(['']); // '' = 首个 chunk（无 cursor 参数）
    const queue = [];
    let fetched = 1;
    let truncated = false;
    // 首个 chunk 单独探路：普通 docx 直接成功；wiki 挂载页若被要求容器参数，
    // 在这里补拿 space_id 重试，之后所有 chunk 沿用同一套参数
    let extraParams = null;
    let first;
    try {
      first = await this._fetchChunk(token, '', null);
    } catch (e) {
      extraParams = await this._wikiParams();
      if (!extraParams) throw e;
      first = await this._fetchChunk(token, '', extraParams);
    }
    this._merge(blockMap, first);
    this._enqueue(first, seen, queue);

    while (queue.length && !truncated) {
      const batch = queue.splice(0, this.FETCH_CONCURRENCY);
      const chunks = await Promise.all(batch.map(c => this._fetchChunk(token, c, extraParams)));
      for (const data of chunks) {
        this._merge(blockMap, data);
        this._enqueue(data, seen, queue);
      }
      fetched += chunks.length;
      if (fetched >= this.MAX_CHUNKS && queue.length) truncated = true;
      if (window.__inkProgress) {
        window.__inkProgress(`正在拉取文档数据（已获取 ${Object.keys(blockMap).length} 个内容块）…`);
      }
    }
    return { blockMap, truncated };
  },

  async _fetchChunk(token, cursor, extraParams) {
    const u = new URL('/space/api/docx/pages/client_vars', location.origin);
    u.searchParams.set('id', token);
    u.searchParams.set('mode', '7');
    u.searchParams.set('limit', String(this.CHUNK_LIMIT));
    if (cursor) u.searchParams.set('cursor', cursor);
    if (extraParams) {
      for (const [k, v] of Object.entries(extraParams)) u.searchParams.set(k, v);
    }
    const res = await InkExporter.fetchWithTimeout(u.href, { credentials: 'include' });
    if (!res.ok) throw new Error(`client_vars HTTP ${res.status}`);
    const body = await res.json();
    if (!body || body.code !== 0 || !body.data || !body.data.block_map) {
      throw new Error(`client_vars 返回异常（code=${body && body.code}）`);
    }
    return body.data;
  },

  _merge(blockMap, data) {
    Object.assign(blockMap, data.block_map);
  },

  _enqueue(data, seen, queue) {
    const nexts = (data.next_cursors || []).concat(data.has_more && data.cursor ? [data.cursor] : []);
    for (const c of nexts) {
      if (c && !seen.has(c)) { seen.add(c); queue.push(c); }
    }
  },

  /**
   * wiki 挂载页的容器参数兜底：space_id 只存在于页面 JS 变量（隔离世界不可读），
   * 用 get_path 接口按 wiki_token 换取。响应结构未固化，按 key 名防御式搜索。
   */
  async _wikiParams() {
    const m = location.pathname.match(/\/wiki\/([A-Za-z0-9]+)/);
    if (!m) return null;
    try {
      const u = new URL('/space/api/wiki/v2/tree/get_path/', location.origin);
      u.searchParams.set('wiki_token', m[1]);
      u.searchParams.set('with_space', 'true');
      const res = await InkExporter.fetchWithTimeout(u.href, { credentials: 'include' });
      if (!res.ok) return null;
      const spaceId = this._findKey(await res.json(), 'space_id');
      if (!spaceId) return null;
      return { wiki_space_id: String(spaceId), container_type: 'wiki2.0', container_id: m[1] };
    } catch (e) {
      return null;
    }
  },

  _findKey(obj, key, depth) {
    if (!obj || typeof obj !== 'object' || (depth || 0) > 6) return null;
    if (obj[key] !== undefined && typeof obj[key] !== 'object') return obj[key];
    for (const k of Object.keys(obj)) {
      const found = this._findKey(obj[k], key, (depth || 0) + 1);
      if (found !== null) return found;
    }
    return null;
  },

  /* ---------- 评论采集 ---------- */

  /** 块上的 comments 字段装的是评论 id；按块出现顺序收集 = 评论按文档顺序输出 */
  _collectCommentIds(d, report) {
    if (!d || !Array.isArray(d.comments)) return;
    for (const id of d.comments) {
      if (id && !report._seenComments.has(id)) {
        report._seenComments.add(id);
        report.commentIds.push(id);
      }
    }
  },

  /**
   * 评论正文走 comment/batch 接口按 id 批量换取（页面自身的同款调用）。
   * quote 字段是被划线的原文——直接对接现有的「==高亮==[^脚注]」锚定体系；
   * is_whole=1 是全文评论，进文末评论区；comment_list 首条是评论、其余是回复。
   */
  async _fetchComments(token, ids) {
    const byId = {};
    for (let i = 0; i < ids.length; i += 100) {
      const data = await this._commentBatch(token, ids.slice(i, i + 100));
      Object.assign(byId, (data && data.comments) || {});
    }
    const out = [];
    for (const id of ids) {
      const c = byId[id];
      if (!c || c.delete_flag) continue;
      const msgs = (c.comment_list || []).filter(m => m && !m.delete_flag);
      if (!msgs.length) continue;
      const head = msgs[0];
      const toAnn = (m, extraTime) => InkIR.annotation({
        kind: c.is_whole ? 'page' : 'inline',
        author: m.name || null,
        time: m.create_time ? m.create_time + (extraTime || '') : null,
        content: this._commentText(m.content),
      });
      const ann = toAnn(head, c.finish ? ' · 已解决' : '');
      if (!c.is_whole) ann.anchorText = c.quote || null;
      ann.replies = msgs.slice(1).map(m => toAnn(m));
      out.push(ann);
    }
    return out;
  },

  async _commentBatch(token, ids) {
    const body = new URLSearchParams();
    body.set('obj_type', '22'); // 22 = docx（抓包实测值）
    body.set('token', token);
    for (const id of ids) body.append('comment_ids', id);
    body.set('need_reply', 'true');
    const headers = {};
    // 页面自身的调用带 x-csrftoken（值来自 cookie）；读得到就带上，读不到先试裸调
    const csrf = (document.cookie.match(/(?:^|;\s*)_?csrf_token=([^;]+)/) || [])[1];
    if (csrf) headers['x-csrftoken'] = decodeURIComponent(csrf);
    let lastErr = null;
    for (const base of this._apiBases()) {
      try {
        const res = await InkExporter.fetchWithTimeout(base + '/space/api/comment/batch', {
          method: 'POST', credentials: 'include', headers, body,
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        if (!json || json.code !== 0 || !json.data) {
          throw new Error('code=' + (json && json.code));
        }
        return json.data;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  },

  /** 评论接口在独立域名（internal-api-space.*）；未知租户域退回同源尝试 */
  _apiBases() {
    const m = location.hostname.match(/(feishu\.cn|larksuite\.com)$/);
    const bases = m ? ['https://internal-api-space.' + m[1]] : [];
    bases.push(location.origin);
    return bases;
  },

  /** 评论内容是带标记的富文本（<at> 提及、HTML 实体）→ 可读纯文本。
   *  DOMParser 产出惰性文档：不加载资源、不执行脚本，适合处理不可信输入 */
  _commentText(raw) {
    let s = String(raw || '');
    s = s.replace(/<at\b[^>]*>([\s\S]*?)<\/at>/gi, '$1'); // @提及保留可读名字
    const doc = new DOMParser().parseFromString(s, 'text/html');
    return (doc.body.textContent || '').trim();
  },

  /* ---------- easysync 文本解码 ---------- */

  /** 属性操作串 → [{ text, attrs:{bold:'true',link:'…',…} }] 运行段序列 */
  _decodeRuns(textObj) {
    const at = textObj && textObj.initialAttributedTexts;
    const raw = (at && at.text && at.text['0']) || '';
    const ops = (at && at.attribs && at.attribs['0']) || '';
    if (!raw) return [];
    const pool = (textObj.apool && textObj.apool.numToAttrib) || {};
    if (!ops) return [{ text: raw, attrs: {} }];

    const runs = [];
    let pos = 0;
    const re = /((?:\*[0-9a-z]+)*)(?:\|[0-9a-z]+)?\+([0-9a-z]+)/g;
    let m;
    while ((m = re.exec(ops))) {
      const len = parseInt(m[2], 36);
      const attrs = {};
      (m[1].match(/\*[0-9a-z]+/g) || []).forEach((a) => {
        const pair = pool[String(parseInt(a.slice(1), 36))];
        if (pair) attrs[pair[0]] = pair[1];
      });
      runs.push({ text: raw.slice(pos, pos + len), attrs });
      pos += len;
    }
    // 操作串未覆盖的尾部原样保留（防御：绝不因解码偏差丢正文）
    if (pos < raw.length) runs.push({ text: raw.slice(pos), attrs: {} });
    return runs;
  },

  _plain(textObj) {
    const at = textObj && textObj.initialAttributedTexts;
    return ((at && at.text && at.text['0']) || '').trim();
  },

  /** 富文本渲染进目标元素：粗体/斜体/删除线/下划线/行内代码/链接/行内公式 */
  _renderRich(textObj, target) {
    const INLINE_TAGS = [
      ['inlineCode', 'code'], ['bold', 'strong'], ['italic', 'em'],
      ['strikethrough', 's'], ['underline', 'u'],
    ];
    for (const run of this._decodeRuns(textObj)) {
      if (!run.text) continue;
      if (run.attrs.equation) {
        const tex = this._safeDecode(run.attrs.equation).trim();
        const el = document.createElement('span');
        el.setAttribute('data-ink-math', tex);
        el.textContent = tex;
        target.appendChild(el);
        continue;
      }
      let node = this._textWithBreaks(run.text);
      for (const [attr, tag] of INLINE_TAGS) {
        if (this._attrOn(run.attrs[attr])) {
          const w = document.createElement(tag);
          w.appendChild(node);
          node = w;
        }
      }
      if (run.attrs.link) {
        const a = document.createElement('a');
        a.setAttribute('href', this._safeDecode(run.attrs.link));
        a.appendChild(node);
        node = a;
      }
      target.appendChild(node);
    }
  },

  /** 块内换行 → <br>（代码块除外，那边整段保留原文） */
  _textWithBreaks(str) {
    const frag = document.createDocumentFragment();
    const lines = str.split('\n');
    lines.forEach((line, i) => {
      if (i > 0) frag.appendChild(document.createElement('br'));
      if (line) frag.appendChild(document.createTextNode(line));
    });
    return frag;
  },

  _attrOn(v) {
    return v !== undefined && v !== null && v !== '' && v !== 'false';
  },

  _safeDecode(v) {
    try { return decodeURIComponent(v); } catch (e) { return v; }
  },

  /* ---------- 块树 → DOM ---------- */

  _renderChildren(ids, map, parent, report) {
    let list = null; // 相邻同类列表块聚合进同一个 ul/ol
    for (const id of ids) {
      const block = map[id];
      if (!block || !block.data) {
        report.missing += 1;
        list = null;
        continue;
      }
      const d = block.data;
      const type = d.type || '';
      this._collectCommentIds(d, report);

      if (type === 'bullet' || type === 'ordered' || type === 'todo') {
        const wantTag = type === 'ordered' ? 'ol' : 'ul';
        if (!list || list.tagName.toLowerCase() !== wantTag) {
          list = document.createElement(wantTag);
          if (type === 'ordered' && d.seq && d.seq !== '1') list.setAttribute('start', d.seq);
          parent.appendChild(list);
        }
        const li = document.createElement('li');
        if (type === 'todo') {
          const box = document.createElement('input');
          box.setAttribute('type', 'checkbox');
          if (d.done === true || d.checked === true || d.finished === true) {
            box.setAttribute('checked', '');
          }
          li.appendChild(box); // GFM 规则会转成 "[ ] "（自带尾随空格）
        }
        this._renderRich(d.text, li);
        // 子块（嵌套列表 / 列表项下的段落）渲染进 li，天然形成正确缩进
        if (d.children && d.children.length) this._renderChildren(d.children, map, li, report);
        list.appendChild(li);
        continue;
      }
      list = null;
      this._renderBlock(type, d, map, parent, report);
    }
  },

  _renderBlock(type, d, map, parent, report) {
    const headingMatch = type.match(/^heading(\d)$/);
    if (headingMatch) {
      const h = document.createElement('h' + Math.min(Number(headingMatch[1]), 6));
      this._renderRich(d.text, h);
      parent.appendChild(h);
      // 折叠标题的内容是标题块的子块：跟在标题后同级输出
      if (d.children && d.children.length) this._renderChildren(d.children, map, parent, report);
      return;
    }

    switch (type) {
      case 'text': {
        if (!this._plain(d.text) && !(d.children && d.children.length)) return; // 空行块
        const p = document.createElement('p');
        this._renderRich(d.text, p);
        parent.appendChild(p);
        if (d.children && d.children.length) this._renderChildren(d.children, map, parent, report);
        return;
      }
      case 'quote': {
        const bq = document.createElement('blockquote');
        const p = document.createElement('p');
        this._renderRich(d.text, p);
        bq.appendChild(p);
        if (d.children && d.children.length) this._renderChildren(d.children, map, bq, report);
        parent.appendChild(bq);
        return;
      }
      case 'quote_container': {
        const bq = document.createElement('blockquote');
        this._renderChildren(d.children || [], map, bq, report);
        parent.appendChild(bq);
        return;
      }
      case 'code': {
        const pre = document.createElement('pre');
        const lang = (d.language || '').toLowerCase();
        if (lang && lang !== 'plaintext') InkIR.markCodeBlock(pre, lang);
        const code = document.createElement('code');
        const at = d.text && d.text.initialAttributedTexts;
        code.textContent = (at && at.text && at.text['0']) || '';
        pre.appendChild(code);
        parent.appendChild(pre);
        return;
      }
      case 'divider':
        parent.appendChild(document.createElement('hr'));
        return;
      case 'table':
        this._renderTable(d, map, parent, report);
        return;
      case 'callout': {
        const box = document.createElement('div');
        InkIR.markCallout(box, 'info');
        this._renderChildren(d.children || [], map, box, report);
        parent.appendChild(box);
        return;
      }
      case 'image': {
        const token = this._imageToken(d);
        if (token) {
          const img = document.createElement('img');
          // 与页面自身加载图片同一条下载通道（同源、带登录态，配合 authImages 本地打包）
          img.setAttribute('src', location.origin + '/space/api/box/stream/download/all/' + token);
          parent.appendChild(img);
        } else {
          this._unsupported('图片（数据缺失）', parent, report);
        }
        return;
      }
      case 'isv': {
        const inner = d.data || {};
        // mermaid 图表块（block_type_id 实测值）：data.data 即 mermaid 源码
        if (typeof inner.data === 'string' &&
            (d.block_type_id === 'blk_631fefbbae02400430b8f9f4' || inner.view === 'chart')) {
          const pre = document.createElement('pre');
          InkIR.markCodeBlock(pre, 'mermaid');
          const code = document.createElement('code');
          code.textContent = inner.data;
          pre.appendChild(code);
          parent.appendChild(pre);
        } else {
          this._unsupported('第三方应用块', parent, report);
        }
        return;
      }
      // 布局容器：只透传子块
      case 'grid':
      case 'grid_column':
      case 'synced_source':
        this._renderChildren(d.children || [], map, parent, report);
        return;
      case 'sheet':
        this._unsupported('电子表格', parent, report);
        return;
      case 'bitable':
        this._unsupported('多维表格', parent, report);
        return;
      case 'board':
      case 'whiteboard':
        this._unsupported('画板', parent, report);
        return;
      case 'mindnote':
        this._unsupported('思维笔记', parent, report);
        return;
      case 'file':
        this._unsupported('文件附件', parent, report);
        return;
      case 'iframe':
        this._unsupported('内嵌网页', parent, report);
        return;
      case 'table_cell': // 只应出现在 table 内部，游离出现说明数据异常
        return;
      default: {
        // 未知类型：有文本按段落导出、有子块透传——尽力不丢内容
        if (d.text && this._plain(d.text)) {
          const p = document.createElement('p');
          this._renderRich(d.text, p);
          parent.appendChild(p);
        } else if (d.children && d.children.length) {
          this._renderChildren(d.children, map, parent, report);
        } else {
          this._unsupported(`未知块（${type || '无类型'}）`, parent, report);
        }
      }
    }
  },

  /**
   * 表格：rows_id × columns_id 定位网格，cell_set 以「rowId+colId」拼接为键，
   * merge_info 的 row_span/col_span 转标准 rowspan/colspan——
   * 后续走 markdown.js 现成的表格三档策略（网格展开 / HTML 直通）。
   */
  _renderTable(d, map, parent, report) {
    const rows = d.rows_id || [];
    const cols = d.columns_id || [];
    const cellSet = d.cell_set || {};
    const table = document.createElement('table');
    const covered = new Set(); // 被合并单元格覆盖的网格位（"r,c"）
    rows.forEach((rowId, r) => {
      const tr = document.createElement('tr');
      cols.forEach((colId, c) => {
        if (covered.has(r + ',' + c)) return;
        const cell = cellSet[rowId + colId];
        const td = document.createElement('td');
        const mi = (cell && cell.merge_info) || {};
        const rs = mi.row_span || 1;
        const cs = mi.col_span || 1;
        if (rs > 1) td.setAttribute('rowspan', String(rs));
        if (cs > 1) td.setAttribute('colspan', String(cs));
        for (let i = 0; i < rs; i++) {
          for (let j = 0; j < cs; j++) {
            if (i || j) covered.add((r + i) + ',' + (c + j));
          }
        }
        const cellBlock = cell && map[cell.block_id];
        if (cellBlock && cellBlock.data) {
          this._collectCommentIds(cellBlock.data, report);
          this._renderChildren(cellBlock.data.children || [], map, td, report);
        } else if (cell) {
          report.missing += 1;
        }
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
    parent.appendChild(table);
  },

  _imageToken(d) {
    if (typeof d.token === 'string' && d.token) return d.token;
    const img = d.image || (d.data && d.data.image);
    if (img && typeof img.token === 'string' && img.token) return img.token;
    return null;
  },

  _unsupported(label, parent, report) {
    report.unsupported[label] = (report.unsupported[label] || 0) + 1;
    const p = document.createElement('p');
    const em = document.createElement('em');
    em.textContent = `[飞书${label}：暂不支持导出，请在原文档查看]`;
    p.appendChild(em);
    parent.appendChild(p);
  },
};

window.InkFeishuDocx = InkFeishuDocx;
