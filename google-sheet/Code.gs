/**
 * Christmas Larder: connects the app to this Google Sheet.
 *
 * Setup (once): Extensions > Apps Script, paste this whole file over what's there,
 * Save, then Deploy > New deployment > Web app,
 * "Execute as: Me", "Who has access: Anyone", Deploy, and copy the Web app URL.
 *
 * The sheet gets three tabs, created automatically:
 *   Items     - one row per thing in a place
 *   Places    - your freezers and boxes
 *   Products  - remembered names for each barcode
 */

const TABS = {
  Items: ['id', 'name', 'qty', 'unit', 'placeId', 'added', 'useBy', 'barcode', 'createdAt', 'updatedAt'],
  Places: ['id', 'name', 'order'],
  Products: ['barcode', 'name', 'unit', 'brand', 'source', 'updatedAt'],
};
const KEYS = { Items: 'id', Places: 'id', Products: 'barcode' };
const STARTER_PLACES = ['Freezer 1', 'Freezer 2', 'Sweets box', 'Pickles box'];

function doGet(e) {
  return json_(handle_({ action: (e && e.parameter && e.parameter.action) || 'list' }));
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return json_({ ok: false, error: 'Bad request' }); }
  return json_(handle_(body));
}

function handle_(req) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    setup_();
    switch (req.action) {
      case 'list': return { ok: true, data: snapshot_() };
      case 'saveItem': upsert_('Items', clean_(req.item, TABS.Items)); break;
      case 'deleteItem': remove_('Items', req.id); break;
      case 'adjust': adjust_(req.id, Number(req.delta) || 0); break;
      case 'savePlace': upsert_('Places', clean_(req.place, TABS.Places)); break;
      case 'deletePlace': remove_('Places', req.id); break;
      case 'saveProduct': upsert_('Products', clean_(req.product, TABS.Products)); break;
      case 'ping': return { ok: true, data: { hello: 'Christmas Larder' } };
      default: return { ok: false, error: 'Unknown action' };
    }
    return { ok: true, data: snapshot_() };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  } finally {
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function setup_() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(TABS).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.getRange(1, 1, 1, TABS[name].length).setValues([TABS[name]]).setFontWeight('bold');
      sh.setFrozenRows(1);
      // Keep barcodes and dates as plain text so Sheets doesn't reformat them.
      sh.getRange('A:Z').setNumberFormat('@');
      if (name === 'Places') {
        sh.getRange(2, 1, STARTER_PLACES.length, 3).setValues(STARTER_PLACES.map(function (p, i) {
          return [p.toLowerCase().replace(/[^a-z0-9]+/g, '-'), p, String(i + 1)];
        }));
      }
    }
  });
  const first = ss.getSheetByName('Sheet1');
  if (first && ss.getSheets().length > 1 && first.getLastRow() === 0) ss.deleteSheet(first);
}

function rows_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  const values = sh.getDataRange().getValues();
  const head = values.shift() || [];
  return values.filter(function (r) { return r[0] !== ''; }).map(function (r) {
    const o = {};
    head.forEach(function (h, i) { o[h] = r[i] instanceof Date ? Utilities.formatDate(r[i], 'UTC', 'yyyy-MM-dd') : String(r[i]); });
    return o;
  });
}

function snapshot_() {
  const items = rows_('Items').map(function (r) { r.qty = Number(r.qty) || 0; return r; });
  const places = rows_('Places').map(function (r) { r.order = Number(r.order) || 0; return r; });
  return { items: items, places: places, products: rows_('Products'), at: new Date().toISOString() };
}

function clean_(obj, cols) {
  if (!obj || typeof obj !== 'object') throw new Error('Nothing to save');
  const o = {};
  cols.forEach(function (c) { if (obj[c] !== undefined && obj[c] !== null) o[c] = String(obj[c]).slice(0, 200); });
  return o;
}

function findRow_(sh, key) {
  const col = sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 1).getValues();
  for (let i = 0; i < col.length; i++) if (String(col[i][0]) === String(key)) return i + 2;
  return -1;
}

function upsert_(name, obj) {
  const keyField = KEYS[name];
  const key = obj[keyField];
  if (!key) throw new Error('Missing ' + keyField);
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  const cols = TABS[name];
  const row = findRow_(sh, key);
  if (row === -1) {
    sh.appendRow(cols.map(function (c) { return obj[c] !== undefined ? obj[c] : ''; }));
  } else {
    const current = sh.getRange(row, 1, 1, cols.length).getValues()[0];
    sh.getRange(row, 1, 1, cols.length).setValues([cols.map(function (c, i) { return obj[c] !== undefined ? obj[c] : current[i]; })]);
  }
}

function remove_(name, key) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  const row = findRow_(sh, key);
  if (row !== -1) sh.deleteRow(row);
}

// Adding or taking one happens here, so two people tapping at once both count.
function adjust_(id, delta) {
  const sh = SpreadsheetApp.getActive().getSheetByName('Items');
  const row = findRow_(sh, id);
  if (row === -1) return;
  const qtyCol = TABS.Items.indexOf('qty') + 1;
  const updCol = TABS.Items.indexOf('updatedAt') + 1;
  const now = Math.max(0, (Number(sh.getRange(row, qtyCol).getValue()) || 0) + delta);
  sh.getRange(row, qtyCol).setValue(String(now));
  sh.getRange(row, updCol).setValue(new Date().toISOString());
}
