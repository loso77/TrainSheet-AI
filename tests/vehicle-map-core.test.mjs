import assert from 'node:assert/strict';
import { buildVehicleMapPrompt, normalizeVehicleMapResponse, parseVehicleMapModelText } from '../vehicle-map-core.js';

const rows = (start, end, vehicleStart = 1) => Array.from({ length: end - start + 1 }, (_, index) => [
  start + index,
  String(vehicleStart + index).padStart(3, '0'),
  '',
  String(vehicleStart + index).padStart(3, '0'),
  false,
  false,
  0.97
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
changed[4] = [5, '018', '107', '', true, false, 0.94];
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
  { x: 1, i: 'sihui', d: '2026-08-08', r: [[31, '103', '', '103', false, false, 0.99]] }
] }), 1);
assert.equal(single.pages.length, 1);
assert.equal(single.pages[0].page_type, 'sihui');
assert.equal(single.pages[0].date, '2026-08-08');
assert.equal(single.pages[0].rows[0].effective_vehicle_number, '103');
assert.match(buildVehicleMapPrompt(1), /收到1张照片/);
assert.doesNotMatch(buildVehicleMapPrompt(1), /三张图都出现/);
assert.match(buildVehicleMapPrompt(3), /三张图都出现/);

console.log('vehicle-map-core tests passed');
