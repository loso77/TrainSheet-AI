export const VEHICLE_MAP_PAGES = [
  { id: 'gucheng', label: '古城检修', start: 1, end: 28 },
  { id: 'sihui', label: '四惠检修', start: 31, end: 61 },
  { id: 'tuqiao', label: '1号线检修中心土桥段', start: 71, end: 100 }
];

const PAGE_BY_ID = new Map(VEHICLE_MAP_PAGES.map(page => [page.id, page]));

function asBoolean(value) {
  return value === true || value === 1 || String(value).toLowerCase() === 'true';
}

function confidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function vehicleNumber(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (!/^\d{1,3}$/.test(raw)) return raw;
  return raw.padStart(3, '0');
}

function dateValue(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const match = raw.match(/(20\d{2})\D{0,3}(\d{1,2})\D{0,3}(\d{1,2})/);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function pageIdFromText(value) {
  const text = String(value ?? '').toLowerCase().replace(/\s+/g, '');
  if (!text) return '';
  if (text.includes('gucheng') || text.includes('古城')) return 'gucheng';
  if (text.includes('sihui') || text.includes('四惠')) return 'sihui';
  if (text.includes('tuqiao') || text.includes('土桥')) return 'tuqiao';
  return '';
}

function pageIdFromRows(rows) {
  const counts = new Map(VEHICLE_MAP_PAGES.map(page => [page.id, 0]));
  for (const row of rows) {
    const table = Number(Array.isArray(row) ? row[0] : row?.table_no ?? row?.table ?? row?.n);
    for (const page of VEHICLE_MAP_PAGES) {
      if (Number.isInteger(table) && table >= page.start && table <= page.end) counts.set(page.id, counts.get(page.id) + 1);
    }
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[1] > 0 && ranked[0][1] > (ranked[1]?.[1] || 0) ? ranked[0][0] : '';
}

function compactRow(row) {
  if (Array.isArray(row)) {
    return {
      table_no: row[0], original_vehicle_number: row[1], changed_vehicle_number: row[2],
      effective_vehicle_number: row[3], vehicle_modified: asBoolean(row[4]),
      ambiguity: asBoolean(row[5]), confidence: row[6], note: row[7]
    };
  }
  if (!row || typeof row !== 'object') return {};
  if ('n' in row || 'o' in row || 'e' in row) {
    return {
      table_no: row.n, original_vehicle_number: row.o, changed_vehicle_number: row.c,
      effective_vehicle_number: row.e, vehicle_modified: asBoolean(row.m),
      ambiguity: asBoolean(row.a), confidence: row.p, note: row.note
    };
  }
  return row;
}

function rawPageRows(page) {
  return Array.isArray(page?.r) ? page.r : Array.isArray(page?.rows) ? page.rows : Array.isArray(page?.mappings) ? page.mappings : [];
}

function rawPages(parsed) {
  if (Array.isArray(parsed?.pages)) return parsed.pages;
  if (Array.isArray(parsed)) return parsed;
  return [];
}

function normalizePage(raw, fallbackImageIndex, imageCount = 3) {
  const rows = rawPageRows(raw);
  const requestedId = pageIdFromText(raw?.i ?? raw?.page_type ?? raw?.depot ?? raw?.maintenance_center);
  const inferredId = pageIdFromRows(rows);
  // 表号范围是页面身份的主依据；页脚/模型标签仅在表号完全无法读取时兜底。
  const pageId = inferredId || requestedId;
  const page = PAGE_BY_ID.get(pageId);
  const imageIndex = Number(raw?.x ?? raw?.image_index ?? fallbackImageIndex);
  const pageReasons = [];
  if (!page) pageReasons.push('无法判断表号范围或页面类型');
  if (requestedId && inferredId && requestedId !== inferredId) pageReasons.push('检修中心与表号范围不一致');

  const map = new Map();
  const duplicateTables = new Set();
  for (const rawRow of rows) {
    const source = compactRow(rawRow);
    const tableNo = Number(source.table_no ?? source.table ?? source.tableNumber);
    if (!Number.isInteger(tableNo) || !page || tableNo < page.start || tableNo > page.end) continue;
    if (map.has(tableNo)) {
      duplicateTables.add(tableNo);
      continue;
    }
    const original = vehicleNumber(source.original_vehicle_number ?? source.original_train_number ?? source.vehicle_number);
    const changed = vehicleNumber(source.changed_vehicle_number ?? source.changed_train_number ?? source.replacement_vehicle_number);
    const reportedEffective = vehicleNumber(source.effective_vehicle_number ?? source.effective_train_number);
    const effective = reportedEffective || changed || original;
    const modified = asBoolean(source.vehicle_modified ?? source.train_modified) || Boolean(changed);
    const ambiguous = asBoolean(source.ambiguity);
    const score = confidence(source.confidence);
    const reasons = Array.isArray(source.review_reasons) ? source.review_reasons.map(String) : [];
    if (!effective) reasons.push('车号为空');
    else if (!/^\d{3}$/.test(effective)) reasons.push('车号格式无效');
    if (original && !/^\d{3}$/.test(original)) reasons.push('原车号格式无效');
    if (changed && !/^\d{3}$/.test(changed)) reasons.push('变更车号格式无效');
    if (modified) reasons.push('存在划掉或手写变更');
    if (ambiguous) reasons.push('模型认为最终值不确定');
    if (score < 0.88) reasons.push('最终值置信度不足');
    map.set(tableNo, {
      table_no: tableNo,
      original_vehicle_number: original,
      changed_vehicle_number: changed,
      effective_vehicle_number: effective,
      vehicle_modified: modified,
      ambiguity: ambiguous,
      confidence: score,
      needs_review: false,
      review_reasons: reasons,
      note: String(source.note ?? '').trim()
    });
  }

  const normalizedRows = [];
  if (page) {
    for (let tableNo = page.start; tableNo <= page.end; tableNo += 1) {
      const row = map.get(tableNo) || {
        table_no: tableNo,
        original_vehicle_number: '', changed_vehicle_number: '', effective_vehicle_number: '',
        vehicle_modified: false, ambiguity: true, confidence: 0, needs_review: true,
        review_reasons: ['模型未返回该表号'], note: '模型未返回该表号'
      };
      if (duplicateTables.has(tableNo)) row.review_reasons.push('模型重复返回该表号');
      row.review_reasons = [...new Set(row.review_reasons)];
      row.needs_review = row.review_reasons.length > 0;
      normalizedRows.push(row);
    }
  }
  if (pageReasons.length) {
    for (const row of normalizedRows) {
      row.review_reasons = [...new Set([...row.review_reasons, ...pageReasons])];
      row.needs_review = true;
    }
  }

  return {
    image_index: Number.isInteger(imageIndex) && imageIndex >= 1 && imageIndex <= imageCount ? imageIndex : fallbackImageIndex,
    page_type: pageId,
    maintenance_center: page?.label || String(raw?.maintenance_center ?? raw?.depot ?? '').trim(),
    date: dateValue(raw?.d ?? raw?.date ?? raw?.service_date ?? raw?.document_date),
    rows: normalizedRows,
    needs_review: pageReasons.length > 0,
    review_reasons: pageReasons
  };
}

export function normalizeVehicleMapResponse(parsed, expectedImageCount = 3) {
  const imageCount = Math.max(1, Math.min(3, Number(expectedImageCount) || 3));
  const sourcePages = rawPages(parsed);
  const byImage = new Map();
  sourcePages.forEach((page, index) => {
    const normalized = normalizePage(page, index + 1, imageCount);
    if (!byImage.has(normalized.image_index)) byImage.set(normalized.image_index, normalized);
  });

  const pages = Array.from({ length: imageCount }, (_, index) => index + 1).map(imageIndex => byImage.get(imageIndex) || {
    image_index: imageIndex, page_type: '', maintenance_center: '', date: '', rows: [],
    needs_review: true, review_reasons: ['模型未返回这张照片']
  });
  const seenPageTypes = new Map();
  for (const page of pages) {
    if (!page.page_type) continue;
    if (!seenPageTypes.has(page.page_type)) seenPageTypes.set(page.page_type, []);
    seenPageTypes.get(page.page_type).push(page);
  }
  for (const [pageType, duplicates] of seenPageTypes) {
    if (duplicates.length < 2) continue;
    for (const page of duplicates) {
      page.needs_review = true;
      page.review_reasons.push(`重复识别为${PAGE_BY_ID.get(pageType)?.label || pageType}`);
    }
  }

  const vehicleMap = new Map();
  for (const page of pages) {
    for (const row of page.rows) {
      if (!/^\d{3}$/.test(row.effective_vehicle_number)) continue;
      if (!vehicleMap.has(row.effective_vehicle_number)) vehicleMap.set(row.effective_vehicle_number, []);
      vehicleMap.get(row.effective_vehicle_number).push(row);
    }
  }
  for (const [vehicle, duplicates] of vehicleMap) {
    if (duplicates.length < 2) continue;
    for (const row of duplicates) {
      row.review_reasons.push(`车号${vehicle}重复`);
      row.review_reasons = [...new Set(row.review_reasons)];
      row.needs_review = true;
    }
  }

  const dates = pages.map(page => page.date).filter(Boolean);
  const uniqueDates = [...new Set(dates)];
  const dateConflict = uniqueDates.length > 1;
  if (dateConflict) {
    for (const page of pages) {
      page.needs_review = true;
      page.review_reasons.push('所选照片的运行日期不一致');
      page.review_reasons = [...new Set(page.review_reasons)];
    }
  }
  return {
    pages,
    date: uniqueDates.length === 1 ? uniqueDates[0] : '',
    date_conflict: dateConflict,
    needs_review: pages.some(page => page.needs_review || page.rows.some(row => row.needs_review))
  };
}

export function buildVehicleMapPrompt(expectedImageCount = 3) {
  const imageCount = Math.max(1, Math.min(3, Number(expectedImageCount) || 3));
  const receiptRule = imageCount === 1
    ? '本次只收到1张照片，用于新建或更新该照片所属的一个表号范围。'
    : imageCount === 3
      ? '本次收到3张照片，顺序不固定，用于完整建立当天三个表号范围。'
      : `本次收到${imageCount}张照片，顺序不固定，用于新建或同时更新这些照片所属的表号范围。`;
  const dateRule = imageCount === 1
    ? '运行日期在右上角，必须据实识别并统一输出YYYY-MM-DD。'
    : `运行日期在右上角，统一输出YYYY-MM-DD。所选${imageCount}张图应为同一天，但不得擅自改成一致。`;
  const finalCheck = imageCount === 1
    ? '输出前检查收到的1张图已返回、图片序号为1、表号范围正确。'
    : `输出前检查收到的${imageCount}张图都已返回、图片序号不重复、表号范围正确。`;
  return `你是北京地铁1号线“列车每日运行计划”数据提取助手。${receiptRule}只读取每张照片左侧的表号、车号、变更车号，以及右上角运行日期和页脚检修中心。

三种页面及合法表号：
- gucheng：页脚含“古城检修”，表号01至28。
- sihui：页脚含“四惠检修”，表号31至61。
- tuqiao：页脚含“土桥段”或“1号线检修中心土桥段”，表号71至100。

页面身份首先按左侧表号范围判断，图片顺序不能作为依据。左下角检修中心文字仅作为辅助校验：它有时可能为空、未填写、被裁掉或看不清；这种情况下仍须根据表号范围正常判断页面，不能因此拒绝识别。只有页脚文字与表号范围明确冲突时才降低置信度。${dateRule}

只读取左侧三列：表号、印刷车号、变更车号。不要读取右侧周检车、段备、月修、车组数、其他说明等区域的数字。车号为000至999，必须保留前导零。

修改规则：被横线、斜线、叉号或涂抹划掉的旧值无效；同一行旁边最后一个未划掉的手写或变更车号才是有效值。o保存能确认的印刷/原车号，c保存最后未划掉的变更车号，e保存最终有效车号。只要存在划改或手写变更，m=true。看不清最终值时留空，a=true，禁止猜测。

只返回紧凑JSON，不要Markdown、解释或额外字段：
{"pages":[{"x":1,"i":"gucheng","d":"2026-08-05","r":[[1,"059","","059",false,false,0.98]]}]}
x=图片序号（按收到顺序从1开始），i=页面身份，d=日期，r中每行依次为[表号,原车号,变更车号,最终车号,有划改或手写变更,最终值不确定,置信度]。
每张图只返回其合法范围内的全部表号，每个表号恰好一次；空白也必须返回空字符串。${finalCheck}`;
}

export function parseVehicleMapModelText(text, expectedImageCount = 3) {
  const cleaned = String(text ?? '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch {
    const error = new Error('大模型返回结果不完整或格式无效，本次未计次数。');
    error.status = 502;
    error.publicMessage = error.message;
    throw error;
  }
  return normalizeVehicleMapResponse(parsed, expectedImageCount);
}
