import assert from 'node:assert/strict';
import {
  buildVehicleMapPrompt,
  normalizeVehicleMapResponse,
  parseVehicleMapModelText,
  vehicleHandwritingExamplesPrompt
} from '../vehicle-map-core.js';

const rows = (start, end, vehicleStart = 1) => Array.from({ length: end - start + 1 }, (_, index) => [
  start + index,
  String(vehicleStart + index).padStart(3, '0'),
  '',
  String(vehicleStart + index).padStart(3, '0'),
  false,
  false,
  0.97,
  'none',
  false
]);

const complete = normalizeVehicleMapResponse({ pages: [
  { x: 1, i: 'tuqiao', d: '2026年8月5日', r: rows(71, 100, 200) },
  { x: 2, i: 'gucheng', d: '2026-08-05', r: rows(1, 28, 1) },
  { x: 3, i: 'sihui', d: '2026/8/5', r: rows(31, 61, 101) }
] });

assert.equal(complete.date, '2026-08-05');
assert.equal(complete.date_conflict, false);
assert.deepEqual(complete.pages.map(page => page.page_type), ['tuqiao', 'gucheng', 'sihui']);
assert.deepEqual(complete.pages.map(page => page.rows.length), [30, 28, 31]);
assert.equal(complete.pages[1].rows[0].effective_vehicle_number, '001');

const changed = rows(1, 28, 1);
changed[4] = [5, '018', '107', '107', true, false, 0.94, 'main', true];
const changedResult = normalizeVehicleMapResponse({ pages: [
  { x: 1, i: 'gucheng', d: '2026-08-05', r: changed },
  { x: 2, i: 'sihui', d: '2026-08-05', r: rows(31, 61, 101) },
  { x: 3, i: 'tuqiao', d: '2026-08-05', r: rows(71, 100, 200) }
] });
const changedRow = changedResult.pages[0].rows.find(row => row.table_no === 5);
assert.equal(changedRow.original_vehicle_number, '018');
assert.equal(changedRow.changed_vehicle_number, '107');
assert.equal(changedRow.effective_vehicle_number, '107');
assert.equal(changedRow.needs_review, true);

// 左侧第一组正式“变更车号”栏本身就是有效字段；原印刷车号无需同时被划掉。
const formalChangeCellWithoutStrike = normalizeVehicleMapResponse({ pages: [
  { x: 1, i: 'tuqiao', d: '2026-08-22', r: [
    [76, '033', '103', '103', true, false, 0.96, 'main', true]
  ] }
] }, 1);
const table76 = formalChangeCellWithoutStrike.pages[0].rows.find(row => row.table_no === 76);
assert.equal(table76.original_vehicle_number, '033');
assert.equal(table76.changed_vehicle_number, '103');
assert.equal(table76.effective_vehicle_number, '103');
assert.equal(table76.vehicle_modified, true);
assert.equal(table76.needs_review, true);

// 正式变更格有手写痕迹但最终数字读不清时，必须保留原车号并进入人工确认，不能静默判为未修改。
const unreadableFormalChange = normalizeVehicleMapResponse({ pages: [
  { x: 1, i: 'tuqiao', d: '2026-08-23', r: [
    [83, '105', '', '105', true, true, 0.62, 'main', true]
  ] }
] }, 1);
const table83 = unreadableFormalChange.pages[0].rows.find(row => row.table_no === 83);
assert.equal(table83.original_vehicle_number, '105');
assert.equal(table83.changed_vehicle_number, '');
assert.equal(table83.effective_vehicle_number, '105');
assert.equal(table83.vehicle_modified, true);
assert.equal(table83.needs_review, true);
assert.ok(table83.review_reasons.includes('存在正式变更车号填写或手写划改'));
assert.ok(table83.review_reasons.includes('模型认为最终值不确定'));

const sameRowOtherColumn = normalizeVehicleMapResponse({ pages: [
  { x: 1, i: 'tuqiao', d: '2026-08-22', r: [
    [86, '109', '082', '082', true, false, 0.96, 'other', false]
  ] }
] }, 1);
const table86 = sameRowOtherColumn.pages[0].rows.find(row => row.table_no === 86);
assert.equal(table86.original_vehicle_number, '109');
assert.equal(table86.changed_vehicle_number, '');
assert.equal(table86.effective_vehicle_number, '109');
assert.equal(table86.vehicle_modified, false);
assert.equal(table86.ignored_changed_vehicle_number, '082');
assert.match(table86.note, /同行其他栏位.*082.*已忽略/);
assert.equal(table86.review_reasons.includes('存在正式变更车号填写或手写划改'), false);

const unlocatedLegacyChange = normalizeVehicleMapResponse({ pages: [
  { x: 1, i: 'tuqiao', d: '2026-08-22', r: [
    [86, '109', '082', '082', true, false, 0.96]
  ] }
] }, 1);
const legacyTable86 = unlocatedLegacyChange.pages[0].rows.find(row => row.table_no === 86);
assert.equal(legacyTable86.effective_vehicle_number, '109');
assert.equal(legacyTable86.changed_vehicle_number, '');
assert.ok(legacyTable86.review_reasons.some(reason => /位置无法确认/.test(reason)));

for (const mixedSource of ['main_or_other', 'uncertain_main', 'not_main', '正式/其他']) {
  const mixedLocation = normalizeVehicleMapResponse({ pages: [
    { x: 1, i: 'tuqiao', d: '2026-08-22', r: [
      { n: 86, o: '109', c: '082', e: '082', m: true, a: false, p: 0.96, s: mixedSource, g: true }
    ] }
  ] }, 1);
  const mixedTable86 = mixedLocation.pages[0].rows.find(row => row.table_no === 86);
  assert.equal(mixedTable86.change_source_zone, 'uncertain');
  assert.equal(mixedTable86.effective_vehicle_number, '109');
  assert.equal(mixedTable86.vehicle_modified, false);
  assert.ok(mixedTable86.review_reasons.some(reason => /位置无法确认/.test(reason)));
}

const duplicate = normalizeVehicleMapResponse({ pages: [
  { x: 1, i: 'gucheng', d: '2026-08-05', r: [[1, '100', '', '100', false, false, 0.99]] },
  { x: 2, i: 'sihui', d: '2026-08-05', r: [[31, '100', '', '100', false, false, 0.99]] },
  { x: 3, i: 'tuqiao', d: '2026-08-05', r: [[71, '071', '', '071', false, false, 0.99]] }
] });
assert.ok(duplicate.pages[0].rows[0].review_reasons.includes('车号100重复'));
assert.ok(duplicate.pages[1].rows[0].review_reasons.includes('车号100重复'));
assert.ok(duplicate.pages[0].rows.find(row => row.table_no === 2).review_reasons.includes('模型未返回该表号'));

const inferred = normalizeVehicleMapResponse({ pages: [
  { x: 1, d: '2026-08-05', r: [[31, '099', '', '099', false, false, 0.99]] },
  { x: 2, i: 'gucheng', d: '2026-08-05', r: [] },
  { x: 3, i: 'tuqiao', d: '2026-08-06', r: [] }
] });
assert.equal(inferred.pages[0].page_type, 'sihui');
assert.equal(inferred.pages[0].maintenance_center, '四惠检修');
assert.equal(inferred.pages[0].review_reasons.includes('无法判断检修中心'), false);
assert.equal(inferred.date_conflict, true);
assert.equal(inferred.date, '');

const rangeWinsConflict = normalizeVehicleMapResponse({ pages: [
  { x: 1, i: 'gucheng', d: '2026-08-05', r: [[31, '099', '', '099', false, false, 0.99]] },
  { x: 2, i: 'sihui', d: '2026-08-05', r: [[1, '059', '', '059', false, false, 0.99]] },
  { x: 3, i: 'tuqiao', d: '2026-08-05', r: [[71, '035', '', '035', false, false, 0.99]] }
] });
assert.equal(rangeWinsConflict.pages[0].page_type, 'sihui');
assert.equal(rangeWinsConflict.pages[0].rows[0].effective_vehicle_number, '099');
assert.ok(rangeWinsConflict.pages[0].review_reasons.includes('检修中心与表号范围不一致'));
assert.equal(rangeWinsConflict.pages[0].rows[0].needs_review, true);
assert.ok(rangeWinsConflict.pages[0].rows[0].review_reasons.includes('检修中心与表号范围不一致'));
assert.equal(rangeWinsConflict.pages[1].page_type, 'gucheng');
assert.equal(rangeWinsConflict.pages[1].rows[0].effective_vehicle_number, '059');

const parsed = parseVehicleMapModelText('```json\n{"pages":[]}\n```');
assert.equal(parsed.pages.length, 3);
assert.ok(parsed.pages.every(page => page.needs_review));

const single = parseVehicleMapModelText(JSON.stringify({ pages: [
  { x: 1, i: 'sihui', d: '2026-08-08', p: 'SX2608', t: 'weekend', r: [[31, '103', '', '103', false, false, 0.99]] }
] }), 1);
assert.equal(single.pages.length, 1);
assert.equal(single.pages[0].page_type, 'sihui');
assert.equal(single.pages[0].date, '2026-08-08');
assert.equal(single.pages[0].plan_code, 'SX2608');
assert.equal(single.pages[0].schedule_type, 'weekend');
assert.equal(single.plan_code, 'SX2608');
assert.deepEqual(single.plan_codes, ['SX2608']);
assert.equal(single.schedule_type, 'weekend');
assert.equal(single.pages[0].rows[0].effective_vehicle_number, '103');
assert.match(buildVehicleMapPrompt(1), /收到1张照片/);
assert.doesNotMatch(buildVehicleMapPrompt(1), /收到的3张图/);

const partial = normalizeVehicleMapResponse({ pages: [
  { x: 1, i: 'gucheng', d: '2026-08-16', r: [[1, '059', '', '059', false, false, 0.99]] },
  { x: 2, i: 'sihui', d: '2026-08-16', r: [[31, '103', '', '103', false, false, 0.99]] }
] }, 2);
assert.equal(partial.pages.length, 2);
assert.equal(partial.date, '2026-08-16');
assert.deepEqual(partial.pages.map(page => page.page_type), ['gucheng', 'sihui']);

const mixedPlanCodes = normalizeVehicleMapResponse({ pages: [
  { x: 1, i: 'gucheng', d: '2026-08-08', p: 'SX2608', t: 'weekend', r: [[1, '051', '', '051', false, false, 0.99, 'none', false]] },
  { x: 2, i: 'sihui', d: '2026-08-08', p: 'SX2608', t: 'weekend', r: [[31, '103', '', '103', false, false, 0.99, 'none', false]] },
  { x: 3, i: 'tuqiao', d: '2026-08-08', p: 'SGJR2606', t: '', r: [[71, '048', '', '048', false, false, 0.99, 'none', false]] }
] });
assert.deepEqual(mixedPlanCodes.plan_codes, ['SX2608', 'SGJR2606']);
assert.equal(mixedPlanCodes.plan_code, '');
assert.equal(mixedPlanCodes.schedule_type, 'weekend');
assert.equal(mixedPlanCodes.pages[2].plan_code, 'SGJR2606');
assert.equal(mixedPlanCodes.pages[2].schedule_type, '');

const missingSecond = parseVehicleMapModelText('{"pages":[{"x":1,"i":"gucheng","d":"2026-08-16","r":[]}]}', 2);
assert.equal(missingSecond.pages.length, 2);
assert.equal(missingSecond.pages[1].needs_review, true);
assert.ok(missingSecond.pages[1].review_reasons.includes('模型未返回这张照片'));

assert.match(buildVehicleMapPrompt(2), /收到2张照片/);
assert.match(buildVehicleMapPrompt(2), /收到的2张图都已返回/);
assert.match(buildVehicleMapPrompt(3), /收到3张照片/);
assert.match(buildVehicleMapPrompt(3), /收到的3张图都已返回/);
assert.match(buildVehicleMapPrompt(3), /不得把横向相邻但位于其他列的数字归给正式表号/);
assert.match(buildVehicleMapPrompt(3), /正式“变更车号”表头下方有时会被细竖线分成多个连续填写小格/);
assert.match(buildVehicleMapPrompt(3), /不得越过正式变更车号栏的最外侧右框线/);
assert.match(buildVehicleMapPrompt(3), /变更证据位置/);
assert.match(buildVehicleMapPrompt(3), /即使正式印刷车号没有被划掉，也以该变更车号为最终车号/);
assert.match(buildVehicleMapPrompt(3), /两种情况都独立构成正式变更，不要求同时出现/);
assert.match(buildVehicleMapPrompt(3), /先检查每一行正式变更车号格是否存在任何非印刷笔迹/);
assert.match(buildVehicleMapPrompt(3), /不得因为手写数字被斜线穿过、与表格线重叠或暂时读不清就判为无修改/);
assert.match(buildVehicleMapPrompt(3), /无法确认最终数字时.*m=true.*a=true.*s=main.*g=true/);
assert.match(buildVehicleMapPrompt(3), /按从左到右读取修改顺序/);
assert.match(buildVehicleMapPrompt(3), /原车号063.*依次写入046、054.*c和e都必须返回054/);
assert.match(buildVehicleMapPrompt(3), /多次修改时优先只包住最右侧最终值所在小格/);
assert.doesNotMatch(buildVehicleMapPrompt(3), /左侧第一个正式[“\"]?变更车号/);
assert.match(buildVehicleMapPrompt(3), /p保存完整代号，例如SX2608、PR2607、SGJR2606/);
assert.match(buildVehicleMapPrompt(3), /SGJR本身是中性代号/);
assert.match(buildVehicleMapPrompt(1), /目标单元格边界/);

const handwritingBbox = normalizeVehicleMapResponse({ pages: [
  {
    x: 1,
    i: 'tuqiao',
    d: '2026-08-23',
    r: [[83, '105', '058', '058', true, false, 0.86, 'main', true, [318, 462, 446, 512]]]
  }
] }, 1);
const handwritingRow = handwritingBbox.pages[0].rows.find(row => row.table_no === 83);
assert.equal(handwritingRow.changed_vehicle_number, '058');
assert.deepEqual(handwritingRow.change_cell_bbox, [318, 462, 446, 512]);

const repeatedChange = normalizeVehicleMapResponse({ pages: [
  {
    x: 1,
    i: 'gucheng',
    d: '2026-08-24',
    r: [[7, '063', '054', '054', true, false, 0.94, 'main', true, [392, 314, 458, 348]]]
  }
] }, 1);
const table07 = repeatedChange.pages[0].rows.find(row => row.table_no === 7);
assert.equal(table07.original_vehicle_number, '063');
assert.equal(table07.changed_vehicle_number, '054');
assert.equal(table07.effective_vehicle_number, '054');
assert.equal(table07.vehicle_modified, true);
assert.deepEqual(table07.change_cell_bbox, [392, 314, 458, 348]);

const handwritingPrompt = vehicleHandwritingExamplesPrompt([
  { confirmed_value: '058', original_value: '105', model_value: '052' }
]);
assert.match(handwritingPrompt, /058/);
assert.match(handwritingPrompt, /不能.*拆成.*2.*划线/);

console.log('vehicle-map-core tests passed');
