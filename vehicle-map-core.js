export const VEHICLE_MAP_PAGES = [
  { id: 'gucheng', label: '古城检修', start: 1, end: 28 },
  { id: 'sihui', label: '四惠检修', start: 31, end: 61 },
  { id: 'tuqiao', label: '1号线检修中心土桥段', start: 71, end: 100 }
];

const PAGE_BY_ID = new Map(VEHICLE_MAP_PAGES.map(page => [page.id, page]));

// 每张独立运行计划表中，正式“表号｜车号｜变更车号”始终位于左侧。
// 坐标限制相对于该表在照片中的外框计算，因此同一张照片横拍或竖拍
// 三张表时，第二、第三张表不会被误判成“整张照片右侧的远处竖列”。
const PRIMARY_CHANGE_CELL_MAX_X_RATIO = 0.52;
const PRIMARY_CHANGE_CELL_MAX_WIDTH_RATIO = 0.24;

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

function normalizedCellBbox(value) {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? [value.x1 ?? value.left, value.y1 ?? value.top, value.x2 ?? value.right, value.y2 ?? value.bottom]
      : [];
  if (source.length !== 4) return [];
  const box = source.map(Number);
  if (box.some(number => !Number.isFinite(number))) return [];
  const [x1, y1, x2, y2] = box.map(number => Math.max(0, Math.min(1000, Math.round(number))));
  if (x2 - x1 < 5 || y2 - y1 < 5) return [];
  return [x1, y1, x2, y2];
}

function pageImageBbox(value) {
  const box = normalizedCellBbox(value);
  return box.length ? box : [0, 0, 1000, 1000];
}

function primaryChangeCellBbox(value, pageBoxValue) {
  const box = normalizedCellBbox(value);
  if (!box.length) return [];
  const pageBox = pageImageBbox(pageBoxValue);
  const [x1, y1, x2, y2] = box;
  const [pageX1, pageY1, pageX2, pageY2] = pageBox;
  const pageWidth = pageX2 - pageX1;
  if (x1 < pageX1 || y1 < pageY1 || x2 > pageX2 || y2 > pageY2) return [];
  if (x2 > pageX1 + pageWidth * PRIMARY_CHANGE_CELL_MAX_X_RATIO) return [];
  if (x2 - x1 > pageWidth * PRIMARY_CHANGE_CELL_MAX_WIDTH_RATIO) return [];
  return box;
}

function changeSourceZone(value) {
  const text = String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  const noneValues = new Set(['', 'none', 'nochange', '无', '未变更']);
  const mainValues = new Set([
    'main', 'primary', 'formal', 'target', 'maincell', 'primarycell', 'formalcell', 'targetcell',
    '正式', '正式栏', '正式格', '主表', '目标格', '目标区', '目标区内'
  ]);
  const otherValues = new Set([
    'other', 'secondary', 'reserve', 'inspection', 'note', 'othercell', 'secondarycell',
    '预备', '预备栏', '周检', '周检栏', '备注', '备注栏', '其他', '其他栏位', '非目标区'
  ]);
  if (noneValues.has(text)) return 'none';
  if (mainValues.has(text)) return 'main';
  if (otherValues.has(text)) return 'other';
  return 'uncertain';
}

function planCodeValue(value) {
  const text = String(value ?? '').trim().toUpperCase();
  const match = text.match(/\b(?:SX|PR|SGJR)[A-Z0-9-]*\d[A-Z0-9-]*\b/);
  return match ? match[0] : '';
}

function scheduleTypeValue(value, planCode = '') {
  const text = String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (['weekend', 'doubleholiday', 'doubleoff', '双休', '双休日', '节假日'].includes(text)) return 'weekend';
  if (['weekday', 'workday', '平日', '工作日'].includes(text)) return 'weekday';
  if (/^SX/.test(planCode)) return 'weekend';
  if (/^PR/.test(planCode)) return 'weekday';
  return '';
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
    const compact = {
      table_no: row[0], original_vehicle_number: row[1], changed_vehicle_number: row[2],
      effective_vehicle_number: row[3], vehicle_modified: asBoolean(row[4]),
      ambiguity: asBoolean(row[5]), confidence: row[6]
    };
    if (row.length >= 9) {
      compact.change_source_zone = row[7];
      compact.change_in_primary_vehicle_cell = asBoolean(row[8]);
      if (Array.isArray(row[9]) || (row[9] && typeof row[9] === 'object')) {
        compact.change_cell_bbox = row[9];
        compact.note = row[10];
      } else {
        compact.note = row[9];
      }
    } else {
      // 兼容旧模型曾在第8项返回备注的格式。旧格式没有单元格归属证据。
      compact.note = row[7];
    }
    return compact;
  }
  if (!row || typeof row !== 'object') return {};
  if ('n' in row || 'o' in row || 'e' in row || 's' in row || 'g' in row) {
    return {
      table_no: row.n, original_vehicle_number: row.o, changed_vehicle_number: row.c,
      effective_vehicle_number: row.e, vehicle_modified: asBoolean(row.m),
      ambiguity: asBoolean(row.a), confidence: row.p,
      change_source_zone: row.s,
      change_in_primary_vehicle_cell: asBoolean(row.g),
      change_cell_bbox: row.b,
      note: row.note
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
  const planCode = planCodeValue(
    raw?.p ?? raw?.plan_code ?? raw?.planCode ?? raw?.plan_number ?? raw?.document_code ?? raw?.document_title ?? raw?.title
  );
  const scheduleType = scheduleTypeValue(
    raw?.t ?? raw?.schedule_type ?? raw?.plan_type ?? raw?.timetable_type,
    planCode
  );
  const pageBox = pageImageBbox(raw?.q ?? raw?.page_bbox ?? raw?.sheet_bbox ?? raw?.document_bbox);
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
    const reportedChanged = vehicleNumber(source.changed_vehicle_number ?? source.changed_train_number ?? source.replacement_vehicle_number);
    const reportedEffective = vehicleNumber(source.effective_vehicle_number ?? source.effective_train_number);
    const markedModified = asBoolean(source.vehicle_modified ?? source.train_modified);
    const reportedDifferent = Boolean(reportedEffective && original && reportedEffective !== original);
    const claimsModification = markedModified || Boolean(reportedChanged) || reportedDifferent;
    const sourceZone = changeSourceZone(source.change_source_zone ?? source.source_zone ?? source.vehicle_change_source);
    const changeInPrimaryCell = asBoolean(
      source.change_in_primary_vehicle_cell
      ?? source.modification_in_target_cell
      ?? source.change_inside_target_cell
    );
    const reportedChangeCellBbox = changeInPrimaryCell
      ? normalizedCellBbox(source.change_cell_bbox ?? source.target_cell_bbox ?? source.bbox)
      : [];
    const changeCellBbox = primaryChangeCellBbox(reportedChangeCellBbox, pageBox);
    const changedCandidate = reportedChanged || (reportedDifferent ? reportedEffective : '');
    const changeValueHasSafeLocation = !changedCandidate || changeCellBbox.length > 0;
    const trustedModification = claimsModification && sourceZone === 'main' && changeInPrimaryCell && changeValueHasSafeLocation;
    const rejectedByGeometry = claimsModification && sourceZone === 'main' && changeInPrimaryCell &&
      Boolean(changedCandidate) && !changeCellBbox.length;
    const explicitlyOutsideTarget = claimsModification && sourceZone === 'other' && !changeInPrimaryCell;
    const ignoredChanged = !trustedModification
      ? changedCandidate
      : '';
    const changed = trustedModification
      ? changedCandidate
      : '';
    const effective = trustedModification
      ? (reportedEffective || changed || original)
      : claimsModification
        ? original
        : (reportedEffective || original);
    const modified = trustedModification;
    const ambiguous = asBoolean(source.ambiguity);
    const score = confidence(source.confidence);
    const reasons = Array.isArray(source.review_reasons) ? source.review_reasons.map(String) : [];
    const noteParts = [String(source.note ?? '').trim()].filter(Boolean);
    if (claimsModification && !trustedModification) {
      if (rejectedByGeometry) {
        reasons.push(ignoredChanged
          ? `疑似变更车号${ignoredChanged}的坐标缺失或超出左侧正式栏安全边界，已保留正式车号`
          : '划改坐标缺失或超出左侧正式栏安全边界，已保留正式车号');
      } else if (explicitlyOutsideTarget) {
        noteParts.push(ignoredChanged
          ? `同行其他栏位的疑似车号${ignoredChanged}已忽略`
          : '同行其他栏位的划改已忽略');
      } else {
        reasons.push(ignoredChanged
          ? `疑似变更车号${ignoredChanged}的位置无法确认，已保留正式车号`
          : '划改位置无法确认，已保留正式车号');
      }
    }
    if (!effective) reasons.push('车号为空');
    else if (!/^\d{3}$/.test(effective)) reasons.push('车号格式无效');
    if (original && !/^\d{3}$/.test(original)) reasons.push('原车号格式无效');
    if (changed && !/^\d{3}$/.test(changed)) reasons.push('变更车号格式无效');
    if (modified) reasons.push('存在正式变更车号填写或手写划改');
    if (ambiguous) reasons.push('模型认为最终值不确定');
    if (score < 0.88) reasons.push('最终值置信度不足');
    map.set(tableNo, {
      table_no: tableNo,
      original_vehicle_number: original,
      changed_vehicle_number: changed,
      effective_vehicle_number: effective,
      vehicle_modified: modified,
      change_source_zone: sourceZone,
      change_in_primary_vehicle_cell: changeInPrimaryCell,
      change_cell_bbox: changeCellBbox,
      ignored_changed_vehicle_number: ignoredChanged,
      ambiguity: ambiguous,
      confidence: score,
      needs_review: false,
      review_reasons: reasons,
      note: [...new Set(noteParts)].join('；')
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
    plan_code: planCode,
    schedule_type: scheduleType,
    page_bbox: pageBox,
    rows: normalizedRows,
    needs_review: pageReasons.length > 0,
    review_reasons: pageReasons
  };
}

export function normalizeVehicleMapResponse(parsed, expectedImageCount = 3) {
  const imageCount = Math.max(1, Math.min(3, Number(expectedImageCount) || 3));
  const sourcePages = rawPages(parsed);
  const pages = sourcePages.map((page, index) => normalizePage(
    page,
    imageCount === 1 ? 1 : Math.min(index + 1, imageCount),
    imageCount
  ));
  for (let imageIndex = 1; imageIndex <= imageCount; imageIndex += 1) {
    if (pages.some(page => page.image_index === imageIndex)) continue;
    pages.push({
      image_index: imageIndex, page_type: '', maintenance_center: '', date: '', rows: [],
      page_bbox: [0, 0, 1000, 1000], needs_review: true, review_reasons: ['模型未返回这张照片']
    });
  }
  pages.sort((a, b) => a.image_index - b.image_index ||
    VEHICLE_MAP_PAGES.findIndex(page => page.id === a.page_type) - VEHICLE_MAP_PAGES.findIndex(page => page.id === b.page_type));
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
  const planCodes = [...new Set(pages.map(page => page.plan_code).filter(Boolean))];
  const scheduleTypes = [...new Set(pages.map(page => page.schedule_type).filter(Boolean))];
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
    plan_code: planCodes.length === 1 ? planCodes[0] : '',
    plan_codes: planCodes,
    schedule_type: scheduleTypes.length === 1 ? scheduleTypes[0] : '',
    schedule_types: scheduleTypes,
    needs_review: pages.some(page => page.needs_review || page.rows.some(row => row.needs_review))
  };
}

export function buildVehicleMapPrompt(expectedImageCount = 3) {
  const imageCount = Math.max(1, Math.min(3, Number(expectedImageCount) || 3));
  const receiptRule = imageCount === 1
    ? '本次只收到1张照片。它可能只拍到一张运行计划表，也可能在同一画面中同时拍到古城、四惠、土桥三张彼此独立的完整运行计划表。必须先数清独立表格外框：一张表返回一个page；若画面中有三张表则返回三个page，三个page的x都为1且i各不相同。'
    : imageCount === 3
      ? '本次收到3张照片，顺序不固定，用于完整建立当天三个表号范围。'
      : `本次收到${imageCount}张照片，顺序不固定，用于新建或同时更新这些照片所属的表号范围。`;
  const dateRule = imageCount === 1
    ? '运行日期在右上角，必须据实识别并统一输出YYYY-MM-DD。'
    : `运行日期在右上角，统一输出YYYY-MM-DD。所选${imageCount}张图应为同一天，但不得擅自改成一致。`;
  const finalCheck = imageCount === 1
    ? '输出前检查收到的1张图已返回、所有page的图片序号均为1；若画面含三张独立表格，必须确认三个表号范围均已返回且没有把三张表误当成一张表内的三组竖列。'
    : `输出前检查收到的${imageCount}张图都已返回、图片序号不重复、表号范围正确。`;
  return `你是北京地铁1号线“列车每日运行计划”数据提取助手。${receiptRule}只读取每张独立表格左侧的正式表号、正式车号、正式变更车号，以及该表右上角运行日期和页脚检修中心。

三种页面及合法表号：
- gucheng：页脚含“古城检修”，表号01至28。
- sihui：页脚含“四惠检修”，表号31至61。
- tuqiao：页脚含“土桥段”或“1号线检修中心土桥段”，表号71至100。

页面身份首先按左侧表号范围判断，图片顺序不能作为依据。左下角检修中心文字仅作为辅助校验：它有时可能为空、未填写、被裁掉或看不清；这种情况下仍须根据表号范围正常判断页面，不能因此拒绝识别。只有页脚文字与表号范围明确冲突时才降低置信度。${dateRule}

独立表格定位：
- 每个page必须用q返回该张独立运行计划表在所属完整照片中的外框[x1,y1,x2,y2]，坐标按完整照片宽高归一化到0至1000。q应覆盖该表从标题、全部栏位到页脚检修中心的完整纸面或表格区域，不能只框左侧目标栏。
- 同一照片包含三张表时，先按三个互不重叠的q分别识别，再在每个q内部独立寻找最左侧第一组正式栏。三个page都令x=1，不得把第二、第三张表当成第一张表的预备区、周检栏或远处竖列。
- 单张照片只有一张表时也返回q；无法精确定位外框时可用[0,0,1000,1000]。同一照片中明显存在多张表却无法可靠分清外框时，不得跨表拼接数字，应分别返回能确认的page并降低置信度。

目标数据区必须按竖向表格边界定位，而不是按整条横行联想：
- 目标区仅为图片最左侧第一组“表号｜车号｜变更车号”。正式“变更车号”表头下方有时会被细竖线分成多个连续填写小格，这些小格仍属于同一个正式变更车号栏；目标区右边界必须取该表头覆盖范围的最外侧右框线，而不是第一个填写小格的右框线。
- “连续填写小格”只指同一个正式“变更车号”表头正下方、彼此直接相邻且中间没有出现新表头或分区标题的小格。遇到“预备”、第二个“车号/变更车号”表头、周检车、段备、月修或任何新分区时必须立即停止，不能因为远处数字更清楚就继续向右寻找。
- 页面中部从“预备”开始的第二组“车号｜变更车号”，以及右侧周检车、段备、月修、车组数、其他说明等区域，全部属于非目标区。
- 同一横行右侧出现划线、手写数字或重写，不代表左侧正式表号发生变更；不得把横向相邻但位于其他列的数字归给正式表号。
- 先沿最左侧“表号”列找到正式表号，再只读取该行目标区内紧邻的正式车号格和正式变更车号栏。不得越过正式变更车号栏的最外侧右框线，也不得借用其他横行、预备区或远处竖列的数字补齐车号。车号为000至999，必须保留前导零。

修改规则只适用于目标区，以下两种情况都独立构成正式变更，不要求同时出现：
1. 左侧第一组正式“变更车号”格内明确填写了未划掉的新车号；即使正式印刷车号没有被划掉，也以该变更车号为最终车号。
2. 正式车号格内的旧值被划线、斜线、叉号或涂抹，并在同一正式车号格内写入了可确认的新值。

同一表号可能在正式变更车号栏内连续修改多次：
- 只在该表号同一横行、正式变更车号表头覆盖的连续填写小格内，按从左到右读取修改顺序。
- 若出现多个清晰的三位手写车号，左侧值视为较早修改，最右侧仍有效、未被明确作废的三位车号才是最终值；较早值即使没有另画删除线，也不得覆盖更靠右的后续值。
- 例如原车号063，同一正式变更车号栏依次写入046、054时，c和e都必须返回054，m=true、s=main、g=true；046只表示中间修改，不作为最终值返回。
- 若最右侧值被明确划掉且其后没有可确认的新值，或无法判断多个笔迹的先后与作废关系，不得猜测：令c为空、e=o、m=true、a=true、s=main、g=true并交给人工确认。

必须分两步逐行检查，不能只在读出完整新车号后才报告修改：
- 第一步先检查每一行正式变更车号格是否存在任何非印刷笔迹，并同时检查正式车号格是否存在划线、斜线、叉号、涂抹或重写痕迹。
- 第二步才判断这些笔迹能否组成明确的新车号。不得因为手写数字被斜线穿过、与表格线重叠或暂时读不清就判为无修改。
- 只要能确认笔迹位于正式车号格或左侧第一组正式变更车号栏（包括该表头覆盖的任一连续填写小格），即使读不清新车号，也必须报告该行存在修改证据并交给人工确认：无法确认最终数字时令c为空、e=o、m=true、a=true、s=main、g=true；若连o也读不清则e也留空。
- 对所有g=true的行，还必须用b返回包含最终手写值的目标填写小格边界，格式为[x1,y1,x2,y2]，坐标按该张完整照片宽高归一化到0至1000；多次修改时优先只包住最右侧最终值所在小格。边界只能位于正式车号格或正式“变更车号”表头覆盖范围内，不能越过其最外侧右框线，也不能包含同行预备、第二组车号、周检或备注栏。作为额外安全限制，b必须完整位于其所属独立表格q的左侧52%以内且不能横跨该表的多个大栏位；后端会拒绝坐标缺失、越出q左侧正式区域或异常宽的变更值。若无法可靠定位则b返回空数组[]，同时c必须留空并令a=true，不能用同表远处竖列或合照中另一张表的数字代替。
- 只有正式车号格和正式变更车号格都确认没有非印刷笔迹时，才允许m=false、s=none、g=false。

目标区之外的划改必须忽略。尤其不得把“预备”之后第二组车号或变更车号格内的数字用于左侧正式表号。o保存能确认的正式印刷/原车号，c仅保存上述两种目标区可确认的最终新车号，e保存最终有效车号。m表示正式目标区存在划改、重写或非印刷笔迹证据，不要求新车号已经读清。s表示变更证据位置：main=目标区内，other=仅在预备/周检/备注等非目标区，none=没有变更，uncertain=无法确认位置。g在变更证据明确位于正式车号格或左侧第一组正式变更车号栏的表头覆盖范围内时为true。若s不是main或g不是true，必须令c为空、e=o、m=false；禁止猜测看不清的数字。

标题与运行图类型：逐张读取表格顶部“列车运行计划单”后的标题代号。p保存完整代号，例如SX2608、PR2607、SGJR2606。t只允许weekend、weekday或空字符串：SX明确对应weekend，PR明确对应weekday；SGJR本身是中性代号，若该页没有其他明确证据则t留空，不得仅因SGJR猜测类型。

只返回紧凑JSON，不要Markdown、解释或额外字段：
{"pages":[{"x":1,"i":"gucheng","q":[0,0,1000,1000],"d":"2026-08-05","p":"PR2607","t":"weekday","r":[[1,"059","","059",false,false,0.98,"none",false,[]]]}]}
x=图片序号（按收到顺序从1开始），i=页面身份，q=该独立表格在完整照片中的归一化外框，d=日期，p=标题代号，t=运行图类型，r中每行依次为[表号,原车号,变更车号,最终车号,正式目标区存在有效变更,最终值不确定,置信度,变更证据位置,变更是否位于正式目标格,目标单元格边界b]。
b为目标单元格归一化边界[x1,y1,x2,y2]；无目标区笔迹或无法定位时为[]。
每个page只返回其合法范围内的全部表号，每个表号恰好一次；空白也必须返回空字符串。输出前按表号逐行复查正式车号格和正式变更车号格；对每一个非空c再次核对b确实包住同一横行左侧正式栏内的该手写值，而不是远处竖列、相邻横行、跨栏大框或另一张表。无法通过此项核对时必须清空c、令e=o、a=true。确保任何非印刷笔迹都已用m、a、s、g如实上报，不能静默遗漏。${finalCheck}`;
}

export function vehicleHandwritingExamplesPrompt(examples = []) {
  const safe = (Array.isArray(examples) ? examples : []).slice(0, 4).map((example, index) => ({
    index: index + 1,
    confirmed: vehicleNumber(example?.confirmed_value),
    original: vehicleNumber(example?.original_value),
    model: vehicleNumber(example?.model_value)
  })).filter(example => /^\d{3}$/.test(example.confirmed));
  if (!safe.length) return '';
  const lines = safe.map(example => {
    const details = [];
    if (example.original) details.push(`印刷原车号${example.original}`);
    if (example.model && example.model !== example.confirmed) details.push(`模型曾误读为${example.model}`);
    return `示例${example.index}的小图经人工确认是手写车号${example.confirmed}${details.length ? `（${details.join('，')}）` : ''}`;
  });
  return `以下小图是本设备历次人工校对后保留的正式变更车号格局部样本：\n${lines.join('\n')}\n这些示例只用于理解笔迹形状，不能据此推断本次任何表号的固定车号。先把闭合、回钩或交叉的收笔视为数字本身的一部分；例如人工已确认的手写8不能拆成“2加划线”。仍须以本次照片为准，不相似时不要套用。`;
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
