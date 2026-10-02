/**
 * RÀ SOÁT QUYỀN SỞ HỮU FILE TRONG GOOGLE DRIVE
 *
 * 1. Tìm tất cả thư mục do tài khoản đang chạy script sở hữu (kèm toàn bộ thư mục con).
 * 2. Tìm file/thư mục nằm trong đó nhưng KHÔNG thuộc sở hữu của mình
 *    -> ghi vào Google Sheet (tên, link, chủ sở hữu, email, thư mục chứa).
 * 3. Gửi email nhắc chủ sở hữu chuyển quyền: gom theo từng người,
 *    mỗi người tối đa 1 email / REMIND_INTERVAL_DAYS ngày, tối đa MAX_REMINDERS lần.
 *
 * Cách dùng: xem README.md cùng thư mục.
 */

const CONFIG = {
  // Để trống nếu script được tạo từ trong Google Sheet (Tiện ích mở rộng > Apps Script).
  SPREADSHEET_ID: '',
  SHEET_FILES: 'Danh sách',
  SHEET_LOG: 'Nhật ký',

  REMIND_INTERVAL_DAYS: 7, // khoảng cách tối thiểu giữa 2 lần nhắc cùng một người
  MAX_REMINDERS: 4,        // nhắc tối đa bao nhiêu lần cho mỗi file
  DAILY_HOUR: 7,           // giờ chạy tự động hằng ngày (0-23, theo múi giờ của script)

  SENDER_NAME: 'Giang - Mankai Academy',
  EXCLUDE_EMAILS: [],      // email không bao giờ nhắc, ví dụ: ['boss@company.com']
  DRY_RUN: false,          // true = chỉ ghi nhật ký, KHÔNG gửi email thật (dùng để chạy thử)

  TIME_LIMIT_MS: 4 * 60 * 1000, // Apps Script giới hạn 6 phút / lần chạy, chừa thời gian ghi sheet
};

const FOLDER_MIME = 'application/vnd.google-apps.folder';

const STATUS = {
  PENDING: 'Chưa chuyển',
  DONE: 'Đã xử lý',  // đã chuyển quyền, bị xoá hoặc bị chuyển ra khỏi thư mục
  SKIP: 'Bỏ qua',    // tự đặt tay nếu không muốn nhắc file này nữa
};

const HEADERS = [
  'File ID', 'Tên file', 'Loại', 'Link', 'Chủ sở hữu', 'Email chủ sở hữu',
  'Thư mục chứa', 'Phát hiện lần đầu', 'Quét gần nhất', 'Trạng thái',
  'Nhắc gần nhất', 'Số lần nhắc',
];
const COL = HEADERS.reduce((m, h, i) => { m[h] = i; return m; }, {});

/* ===================== MENU & LỊCH CHẠY ===================== */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Rà soát Drive')
    .addItem('1. Quét cấu trúc thư mục', 'scanFolders')
    .addItem('2. Quét file trong thư mục đã chọn', 'scanDrive')
    .addItem('3. Gửi email nhắc ngay', 'sendReminders')
    .addSeparator()
    .addItem('Bật chạy tự động hằng ngày', 'setupDailyTrigger')
    .addItem('Tắt chạy tự động', 'removeTriggers')
    .addToUi();
}

function setupDailyTrigger() {
  removeTriggers();
  ScriptApp.newTrigger('runDaily').timeBased().everyDays(1).atHour(CONFIG.DAILY_HOUR).create();
  notify_('Đã bật chạy tự động lúc ~' + CONFIG.DAILY_HOUR + 'h mỗi ngày.');
}

function removeTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'runDaily')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

/* ===================== BƯỚC 1: CHỌN THƯ MỤC =====================
 * Quét cấu trúc thư mục bạn sở hữu ra tab "Chọn thư mục" dạng cây (to -> bé),
 * có nút +/- để mở/thu gọn. Tick thư mục mẹ -> tự tick toàn bộ thư mục con (onEdit).
 * Chỉ thư mục đang được tick mới được quét; bỏ tick thư mục con = loại nó ra.
 */

const SHEET_FOLDERS = 'Chọn thư mục';
const FOLDER_HEADERS = ['Chọn', 'Thư mục', 'Đường dẫn', 'Kết quả quét', 'Quét lúc', 'Link',
  'Folder ID', 'Parent ID', 'Tên', 'Cấp'];
const FC = FOLDER_HEADERS.reduce((m, h, i) => { m[h] = i; return m; }, {});
const MAX_GROUP_CALLS = 1500; // cây quá lớn thì bỏ bớt nút +/- để không quá giờ

function scanFolders() {
  scanFolders_();
  getSpreadsheet_().getSheetByName(SHEET_FOLDERS).activate();
  notify_('Đã cập nhật cây thư mục. Bấm dấu + bên trái để mở thư mục con; tick thư mục muốn rà soát rồi chạy bước 2.');
}

function scanFolders_() {
  progress_('Đang đọc cấu trúc thư mục bạn sở hữu...');
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(SHEET_FOLDERS);

  // Giữ lại ô đã tick và kết quả quét từ lần trước (tìm cột theo tên, chịu được bản cũ).
  const old = {};
  if (sheet && sheet.getLastRow() > 1) {
    const data = sheet.getDataRange().getValues();
    const h = data[0];
    const iId = h.indexOf('Folder ID'), iRes = h.indexOf('Kết quả quét'), iAt = h.indexOf('Quét lúc');
    data.slice(1).forEach(r => {
      if (r[iId]) old[r[iId]] = [r[0] === true, iRes >= 0 ? r[iRes] : '', iAt >= 0 ? r[iAt] : ''];
    });
  }

  const info = {};
  let pageToken;
  do {
    const res = Drive.Files.list({
      q: "'me' in owners and mimeType = '" + FOLDER_MIME + "' and trashed = false",
      pageSize: 1000,
      pageToken: pageToken,
      fields: 'nextPageToken, files(id,name,parents)',
    });
    (res.files || []).forEach(f => (info[f.id] = { name: f.name, parent: (f.parents || [])[0] || '' }));
    pageToken = res.nextPageToken;
  } while (pageToken);

  let myDriveId = '';
  try { myDriveId = Drive.Files.get('root', { fields: 'id' }).id; } catch (e) { /* bỏ qua */ }

  // Dựng cây.
  const kids = {};
  Object.keys(info).forEach(id => (kids[info[id].parent] = kids[info[id].parent] || []).push(id));
  const byName = (a, b) => info[a].name.localeCompare(info[b].name, 'vi');
  Object.keys(kids).forEach(p => kids[p].sort(byName));
  const descCount = {};
  const countDesc = id => {
    if (descCount[id] !== undefined) return descCount[id];
    return (descCount[id] = (kids[id] || []).reduce((n, c) => n + 1 + countDesc(c), 0));
  };

  const rows = [];
  const walk = (id, depth, path) => {
    const name = info[id].name;
    const p = path.concat(name);
    const n = countDesc(id);
    const label = (depth === 1 ? '📁 ' : '　　'.repeat(depth - 2) + '└ ') + name +
      (n ? `  (${n} thư mục con)` : '');
    const prev = old[id] || [false, '', ''];
    rows.push([prev[0], label, p.join(' / '), prev[1], prev[2],
      'https://drive.google.com/drive/folders/' + id, id, info[id].parent, name, depth]);
    (kids[id] || []).forEach(c => walk(c, depth + 1, p));
  };
  const roots = Object.keys(info).filter(id => !info[info[id].parent]).sort(byName);
  const sections = [
    ['▼ DRIVE CỦA TÔI', roots.filter(id => info[id].parent === myDriveId)],
    ['▼ THƯ MỤC CỦA BẠN NẰM TRONG THƯ MỤC NGƯỜI KHÁC', roots.filter(id => info[id].parent !== myDriveId)],
  ];
  const headerRows = [];
  sections.forEach(([title, list]) => {
    if (!list.length) return;
    headerRows.push(rows.length);
    rows.push(['', title, '', '', '', '', '', '', '', 0]);
    list.forEach(id => walk(id, 1, []));
  });

  // Tạo lại tab từ đầu (cách sạch nhất để xoá các nhóm +/- cũ).
  const index = sheet ? sheet.getIndex() : ss.getNumSheets() + 1;
  if (sheet) ss.deleteSheet(sheet);
  sheet = ss.insertSheet(SHEET_FOLDERS, index - 1);
  sheet.getRange(1, 1, 1, FOLDER_HEADERS.length).setValues([FOLDER_HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.hideColumns(FC['Folder ID'] + 1, 4);
  sheet.setColumnWidth(FC['Thư mục'] + 1, 420);
  if (!rows.length) return 0;

  sheet.getRange(2, 1, rows.length, FOLDER_HEADERS.length).setValues(rows);
  sheet.getRange(2, 1, rows.length, 1).insertCheckboxes();
  const a1 = i => 'A' + (i + 2) + ':E' + (i + 2);
  sheet.getRangeList(headerRows.map(a1)).removeCheckboxes();
  sheet.getRangeList(headerRows.map(a1)).setFontWeight('bold').setBackground('#e8eaed');
  const level1 = rows.map((r, i) => (r[FC['Cấp']] === 1 ? i : -1)).filter(i => i >= 0);
  if (level1.length) sheet.getRangeList(level1.map(i => 'B' + (i + 2))).setFontWeight('bold');

  // Nút +/- : thư mục con được nhóm dưới thư mục mẹ.
  const levels = rows.map(r => r[FC['Cấp']]);
  const maxDepth = Math.min(8, Math.max.apply(null, levels));
  let calls = 0;
  for (let k = 1; k < maxDepth && calls < MAX_GROUP_CALLS; k++) {
    let start = -1;
    for (let i = 0; i <= levels.length; i++) {
      if (i < levels.length && levels[i] > k) { if (start < 0) start = i; continue; }
      if (start >= 0) {
        sheet.getRange(start + 2, 1, i - start, 1).shiftRowGroupDepth(1);
        calls++;
        start = -1;
      }
    }
  }
  if (calls) {
    sheet.setRowGroupControlPosition(SpreadsheetApp.GroupControlTogglePosition.BEFORE);
    sheet.collapseAllRowGroups();
  }
  return rows.length - headerRows.length;
}

/** Tick/bỏ tick thư mục mẹ -> áp dụng cho toàn bộ thư mục con bên dưới. Tự chạy khi sửa ô. */
function onEdit(e) {
  const sheet = e.range.getSheet();
  if (sheet.getName() !== SHEET_FOLDERS || e.range.getColumn() !== 1 || e.range.getRow() < 2) return;
  const last = sheet.getLastRow();
  if (last < 2) return;
  const checks = sheet.getRange(2, 1, last - 1, 1).getValues();
  const levels = sheet.getRange(2, FC['Cấp'] + 1, last - 1, 1).getValues().map(r => Number(r[0]) || 0);
  const first = e.range.getRow() - 2;
  const end = Math.min(first + e.range.getNumRows(), levels.length);
  let changed = false;
  for (let i = first; i < end; i++) {
    const v = checks[i][0];
    if (typeof v !== 'boolean' || !levels[i]) continue;
    for (let j = i + 1; j < levels.length && levels[j] > levels[i]; j++) {
      if (checks[j][0] !== v) { checks[j][0] = v; changed = true; }
    }
  }
  if (changed) sheet.getRange(2, 1, last - 1, 1).setValues(checks);
}

/** Đọc tab "Chọn thư mục" (luôn đọc mới -> phản ánh ô tick tại thời điểm gọi). */
function loadFolderTree_() {
  const sheet = getSpreadsheet_().getSheetByName(SHEET_FOLDERS);
  const tree = { children: {}, parent: {}, name: {}, selected: [], isSelected: new Set() };
  if (!sheet || sheet.getLastRow() < 2) return tree;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, FOLDER_HEADERS.length).getValues().forEach(r => {
    const id = r[FC['Folder ID']], parent = r[FC['Parent ID']];
    if (!id) return; // dòng tiêu đề nhóm
    const name = r[FC['Tên']] || String(r[FC['Thư mục']]);
    tree.name[id] = name;
    tree.parent[id] = parent;
    (tree.children[parent] = tree.children[parent] || []).push(id);
    if (r[0] === true) { tree.selected.push(id); tree.isSelected.add(id); }
  });
  return tree;
}

/** Thư mục được tick mà thư mục mẹ không được tick = 1 đơn vị quét. */
function isScanRoot_(id, tree) {
  return tree.isSelected.has(id) && !tree.isSelected.has(tree.parent[id]);
}

/** Thư mục gốc + các thư mục con ĐANG ĐƯỢC TICK của nó (bỏ tick = loại cả nhánh đó). */
function expandSelected_(rootId, tree) {
  const out = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    out.push([id, tree.name[id]]);
    (tree.children[id] || []).forEach(c => { if (tree.isSelected.has(c)) stack.push(c); });
  }
  return out;
}

/** Ghi cột "Kết quả quét" cho nhiều thư mục cùng lúc. updates: {folderId: text} */
function setFolderResults_(updates, at) {
  const sheet = getSpreadsheet_().getSheetByName(SHEET_FOLDERS);
  if (!sheet || sheet.getLastRow() < 2) return;
  const n = sheet.getLastRow() - 1;
  const ids = sheet.getRange(2, FC['Folder ID'] + 1, n, 1).getValues();
  const range = sheet.getRange(2, FC['Kết quả quét'] + 1, n, 2);
  const vals = range.getValues();
  let changed = false;
  ids.forEach((r, i) => {
    if (r[0] in updates) { vals[i] = [updates[r[0]], at || '']; changed = true; }
  });
  if (changed) range.setValues(vals);
}

function setFolderResult_(id, text, at) {
  setFolderResults_({ [id]: text }, at);
}

/* ===================== BƯỚC 2: QUÉT FILE (lần lượt từng thư mục đã chọn) =====================
 * - Quét từng thư mục đã tick (thư mục mẹ cùng các thư mục con đang tick), theo thứ tự trong tab.
 * - Trước mỗi thư mục (và giữa chừng) đọc lại ô tick: bỏ tick -> bỏ qua/dừng; tick thêm -> quét luôn.
 * - Hàng đợi thư mục con nằm ở tab ẩn "_Hàng đợi"; file tìm được ghi ngay vào tab ẩn "_Kết quả quét".
 * - Gần hết giờ thì lưu vị trí, hẹn 1 phút sau tự chạy tiếp (continueScan).
 * - Quét xong thì gộp kết quả vào tab "Danh sách".
 */

const SHEET_QUEUE = '_Hàng đợi';
const SHEET_TEMP = '_Kết quả quét';
const QUEUE_HEADERS = ['Folder ID', 'Tên thư mục'];
const TEMP_HEADERS = ['File ID', 'Tên file', 'Loại', 'Link', 'Chủ sở hữu', 'Email chủ sở hữu', 'Thư mục chứa', 'Thư mục gốc ID'];
const STATE_KEY = 'SCAN_STATE';
const PARENT_CHUNK = 40; // số thư mục gộp trong 1 lần hỏi Drive
const ITEM_FIELDS = 'id,name,mimeType,parents,webViewLink,owners(displayName,emailAddress)';

function scanDrive() { startScan_(false); }

/** Việc chạy hằng ngày: cập nhật cây thư mục, quét thư mục đã chọn, xong thì tự gửi nhắc. */
function runDaily() {
  scanFolders_(); // cập nhật thư mục con mới tạo, giữ nguyên các ô đã tick
  startScan_(true);
}

function startScan_(remindAfter) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return notify_('Đang có một lượt quét chạy, vui lòng đợi.');
  let started = false;
  try {
    clearContinueTriggers_();
    const tree = loadFolderTree_();
    if (!tree.selected.length) {
      notify_('Chưa chọn thư mục nào. Chạy "1. Quét cấu trúc thư mục" rồi tick ô "Chọn" ở tab ' + SHEET_FOLDERS + '.');
      return;
    }
    getSheet_(CONFIG.SHEET_FILES, HEADERS);
    resetSheet_(SHEET_QUEUE, QUEUE_HEADERS);
    resetSheet_(SHEET_TEMP, TEMP_HEADERS);
    const status = {};
    tree.selected.forEach(id => (status[id] = isScanRoot_(id, tree) ? 'Chờ quét' : 'Quét cùng thư mục mẹ'));
    setFolderResults_(status);

    saveState_({ done: [], current: null, pos: 0, n: 0, pageToken: null, found: 0, curFound: 0, remindAfter: remindAfter });
    log_('Quét', '', 0, `Bắt đầu quét ${tree.selected.length} thư mục đã chọn`);
    started = true;
  } finally {
    lock.releaseLock();
  }
  if (started) continueScan();
}

/** Chạy tiếp lượt quét đang dở. Được gọi tự động, không cần bấm. */
function continueScan() {
  clearContinueTriggers_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  let state;
  try {
    state = loadState_();
    if (!state) return;
    const startedAt = Date.now();
    const ss = getSpreadsheet_();
    const queue = ss.getSheetByName(SHEET_QUEUE);
    const temp = ss.getSheetByName(SHEET_TEMP);

    while (true) {
      const tree = loadFolderTree_(); // đọc lại ô tick mỗi vòng

      // Thư mục đang quét vừa bị bỏ tick -> dừng, kết quả của nó sẽ không được tính.
      if (state.current && !tree.isSelected.has(state.current.id)) {
        setFolderResult_(state.current.id, 'Đã bỏ chọn, dừng quét', new Date());
        state.current = null;
        state.pageToken = null;
      }

      // Chọn thư mục tiếp theo.
      if (!state.current) {
        const nextId = tree.selected.find(id => state.done.indexOf(id) < 0 && isScanRoot_(id, tree));
        if (!nextId) break;
        state.current = { id: nextId, name: tree.name[nextId] };
        state.pos = 0; state.n = 0; state.pageToken = null; state.curFound = 0;
        queue.clear();
        queue.getRange(1, 1, 1, QUEUE_HEADERS.length).setValues([QUEUE_HEADERS]);
        appendRows_(queue, expandSelected_(nextId, tree));
        setFolderResult_(nextId, 'Đang quét...', new Date());
        saveState_(state);
        progress_(`Đang quét thư mục: ${state.current.name}`);
      }

      // Quét tiếp 1 nhóm thư mục con của thư mục hiện tại.
      const totalFolders = queue.getLastRow() - 1;
      if (!state.pageToken && state.pos >= totalFolders) {
        setFolderResult_(state.current.id, `Xong: ${state.curFound} mục của người khác (${totalFolders} thư mục)`, new Date());
        state.done.push(state.current.id);
        state.current = null;
        saveState_(state);
        continue;
      }
      if (!state.pageToken) state.n = Math.min(PARENT_CHUNK, totalFolders - state.pos);
      const chunk = queue.getRange(state.pos + 2, 1, state.n, 2).getValues();
      const names = {};
      chunk.forEach(r => (names[r[0]] = r[1]));
      const q = "not 'me' in owners and trashed = false and (" +
        chunk.map(r => `'${r[0]}' in parents`).join(' or ') + ')';

      do {
        if (Date.now() - startedAt > CONFIG.TIME_LIMIT_MS) {
          saveState_(state);
          ScriptApp.newTrigger('continueScan').timeBased().after(60 * 1000).create();
          const msg = `Đang quét "${state.current.name}": ${state.pos}/${totalFolders} thư mục con. ` +
            `Đã xong ${state.done.length} thư mục chọn. Sẽ tự chạy tiếp sau 1 phút.`;
          setFolderResult_(state.current.id, `Đang quét... ${state.pos}/${totalFolders} thư mục con, thấy ${state.curFound} mục`, new Date());
          log_('Quét', '', state.found, msg);
          notify_(msg);
          return;
        }
        const res = Drive.Files.list({
          q: q,
          pageSize: 1000,
          pageToken: state.pageToken || undefined,
          fields: 'nextPageToken, files(' + ITEM_FIELDS + ')',
        });
        const rows = [];
        const subfolders = [];
        (res.files || []).forEach(f => {
          if (f.mimeType === FOLDER_MIME) subfolders.push([f.id, f.name]);
          if (!f.owners || !f.owners.length) return;
          const o = f.owners[0];
          rows.push([
            f.id, f.name, f.mimeType === FOLDER_MIME ? 'Thư mục' : 'File', f.webViewLink,
            o.displayName || '', o.emailAddress || '',
            (f.parents || []).map(p => names[p]).filter(Boolean).join(', '),
            state.current.id,
          ]);
        });
        appendRows_(temp, rows);
        // Thư mục con của người khác (không có trong tab chọn) -> quét tiếp bên trong.
        appendRows_(queue, subfolders);
        state.found += rows.length;
        state.curFound += rows.length;
        state.pageToken = res.nextPageToken || null;
        saveState_(state);
      } while (state.pageToken);

      state.pos += state.n;
      saveState_(state);
    }
  } finally {
    lock.releaseLock();
  }
  finishScan_(state);
}

function finishScan_(state) {
  progress_('Đang ghi kết quả vào tab Danh sách...');
  const ss = getSpreadsheet_();
  const temp = ss.getSheetByName(SHEET_TEMP);
  const doneSet = new Set(state.done);
  const found = temp.getLastRow() > 1
    ? temp.getRange(2, 1, temp.getLastRow() - 1, TEMP_HEADERS.length).getValues()
      .filter(r => doneSet.has(r[TEMP_HEADERS.length - 1])) // bỏ kết quả của thư mục bị bỏ chọn giữa chừng
    : [];

  const result = upsertRows_(found);

  temp.clear();
  ss.getSheetByName(SHEET_QUEUE).clear();
  PropertiesService.getScriptProperties().deleteProperty(STATE_KEY);
  const msg = `Quét xong ${state.done.length} thư mục đã chọn: ${result.total} mục không thuộc sở hữu của bạn ` +
    `(mới: ${result.added}, đã xử lý: ${result.done})`;
  log_('Quét', '', result.total, msg);
  notify_(msg);

  if (state.remindAfter) sendReminders();
}

/** found: các dòng theo TEMP_HEADERS. Gộp vào tab Danh sách. */
function upsertRows_(found) {
  const sheet = getSheet_(CONFIG.SHEET_FILES, HEADERS);
  const now = new Date();
  const rows = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length).getValues()
    : [];
  const rowById = {};
  rows.forEach((r, i) => (rowById[r[COL['File ID']]] = i));

  const seen = new Set();
  let added = 0;
  found.forEach(([id, name, type, link, ownerName, ownerEmail, folders]) => {
    if (seen.has(id)) return; // file có nhiều thư mục cha
    seen.add(id);

    if (id in rowById) {
      const r = rows[rowById[id]];
      r[COL['Tên file']] = name;
      r[COL['Loại']] = type;
      r[COL['Link']] = link;
      r[COL['Thư mục chứa']] = folders;
      r[COL['Quét gần nhất']] = now;
      // Đổi chủ sở hữu (vd chuyển cho người thứ 3) -> tính lại từ đầu.
      if (String(r[COL['Email chủ sở hữu']]).toLowerCase() !== String(ownerEmail).toLowerCase()) {
        r[COL['Nhắc gần nhất']] = '';
        r[COL['Số lần nhắc']] = 0;
      }
      r[COL['Chủ sở hữu']] = ownerName;
      r[COL['Email chủ sở hữu']] = ownerEmail;
      if (r[COL['Trạng thái']] === STATUS.DONE) r[COL['Trạng thái']] = STATUS.PENDING;
    } else {
      rows.push([id, name, type, link, ownerName, ownerEmail, folders, now, now, STATUS.PENDING, '', 0]);
      added++;
    }
  });

  // File trước đây có, nay không còn -> đã chuyển quyền / bị xoá / chuyển đi.
  let done = 0;
  rows.forEach(r => {
    if (r[COL['Trạng thái']] === STATUS.PENDING && !seen.has(r[COL['File ID']])) {
      r[COL['Trạng thái']] = STATUS.DONE;
      done++;
    }
  });

  if (rows.length) sheet.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
  return { total: seen.size, added: added, done: done };
}

function saveState_(state) {
  PropertiesService.getScriptProperties().setProperty(STATE_KEY, JSON.stringify(state));
}

function loadState_() {
  const s = PropertiesService.getScriptProperties().getProperty(STATE_KEY);
  return s ? JSON.parse(s) : null;
}

function clearContinueTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'continueScan')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

function resetSheet_(name, headers) {
  const sheet = getSheet_(name, headers);
  sheet.clear();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sheet.hideSheet();
  return sheet;
}

function appendRows_(sheet, rows) {
  if (rows.length) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

/* ===================== BƯỚC 3: NHẮC ===================== */

function sendReminders() {
  const sheet = getSheet_(CONFIG.SHEET_FILES, HEADERS);
  if (sheet.getLastRow() < 2) return notify_('Chưa có dữ liệu. Hãy chạy "Quét Drive" trước.');

  const me = Session.getEffectiveUser().getEmail().toLowerCase();
  const exclude = new Set(CONFIG.EXCLUDE_EMAILS.map(e => e.toLowerCase()));
  const now = new Date();
  const intervalMs = CONFIG.REMIND_INTERVAL_DAYS * 24 * 3600 * 1000;
  const range = sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length);
  const rows = range.getValues();

  // Gom theo chủ sở hữu.
  const byOwner = {};
  rows.forEach((r, i) => {
    const email = String(r[COL['Email chủ sở hữu']]).trim().toLowerCase();
    if (!email || email === me || exclude.has(email)) return;
    if (r[COL['Trạng thái']] !== STATUS.PENDING) return;
    if (Number(r[COL['Số lần nhắc']] || 0) >= CONFIG.MAX_REMINDERS) return;
    const o = byOwner[email] = byOwner[email] || { name: r[COL['Chủ sở hữu']], idx: [], last: 0 };
    o.idx.push(i);
  });

  // Lần nhắc gần nhất của mỗi người (tính trên MỌI file của họ) -> chống nhắc trùng.
  rows.forEach(r => {
    const o = byOwner[String(r[COL['Email chủ sở hữu']]).trim().toLowerCase()];
    const t = r[COL['Nhắc gần nhất']];
    if (o && t instanceof Date) o.last = Math.max(o.last, t.getTime());
  });

  let sent = 0;
  for (const email of Object.keys(byOwner)) {
    const o = byOwner[email];
    if (now - o.last < intervalMs) continue;
    if (!CONFIG.DRY_RUN && MailApp.getRemainingDailyQuota() < 1) {
      log_('Nhắc', '', 0, 'Hết hạn mức gửi email hôm nay, sẽ gửi tiếp vào lần chạy sau');
      break;
    }
    const files = o.idx.map(i => rows[i]);
    try {
      if (!CONFIG.DRY_RUN) {
        MailApp.sendEmail({
          to: email,
          subject: `[Nhờ hỗ trợ] Chuyển quyền sở hữu ${files.length} file trên Google Drive`,
          htmlBody: buildEmail_(o.name, files),
          name: CONFIG.SENDER_NAME,
        });
      }
      if (!CONFIG.DRY_RUN) {
        o.idx.forEach(i => {
          rows[i][COL['Nhắc gần nhất']] = now;
          rows[i][COL['Số lần nhắc']] = Number(rows[i][COL['Số lần nhắc']] || 0) + 1;
        });
      }
      log_('Nhắc', email, files.length, CONFIG.DRY_RUN ? 'CHẠY THỬ - không gửi' : 'Đã gửi');
      sent++;
    } catch (e) {
      log_('Nhắc', email, files.length, 'LỖI: ' + e.message);
    }
  }

  if (!CONFIG.DRY_RUN) range.setValues(rows);
  notify_(`Đã nhắc ${sent} người${CONFIG.DRY_RUN ? ' (chạy thử)' : ''}.`);
}

function buildEmail_(ownerName, files) {
  const myEmail = Session.getEffectiveUser().getEmail();
  const MAX_LIST = 50; // email quá dài sẽ bị Gmail cắt
  const more = files.length > MAX_LIST
    ? `<tr><td colspan="2" style="padding:4px 8px;color:#555">... và ${files.length - MAX_LIST} file khác</td></tr>`
    : '';
  const list = files.slice(0, MAX_LIST).map(r =>
    `<tr><td style="padding:4px 8px"><a href="${esc_(r[COL['Link']])}">${esc_(r[COL['Tên file']])}</a></td>` +
    `<td style="padding:4px 8px;color:#555">${esc_(r[COL['Thư mục chứa']])}</td></tr>`
  ).join('') + more;
  return `
    <p>Chào ${esc_(ownerName || 'bạn')},</p>
    <p>Các file dưới đây đang nằm trong thư mục Drive của mình nhưng vẫn do bạn sở hữu.
       Bạn hỗ trợ chuyển quyền sở hữu sang <b>${esc_(myEmail)}</b> giúp mình nhé:</p>
    <table style="border-collapse:collapse;border:1px solid #ddd">
      <tr style="background:#f3f3f3"><th style="padding:4px 8px;text-align:left">File</th>
      <th style="padding:4px 8px;text-align:left">Thư mục</th></tr>${list}
    </table>
    <p><b>Cách chuyển (khoảng 30 giây/file):</b><br>
      1. Mở file &rarr; bấm <b>Chia sẻ</b>.<br>
      2. Cạnh tên <b>${esc_(myEmail)}</b>, bấm mũi tên quyền &rarr; chọn <b>Chuyển quyền sở hữu</b>.<br>
      3. Bấm <b>Gửi lời mời</b>. Mình sẽ chấp nhận ở phía mình.</p>
    <p style="color:#777;font-size:12px">Nếu bạn có nhiều file, có thể chọn nhiều file cùng lúc trong Drive rồi bấm Chia sẻ.
       Email này được gửi tự động, tối đa 1 lần mỗi ${CONFIG.REMIND_INTERVAL_DAYS} ngày.</p>
    <p>Cảm ơn bạn!<br>${esc_(CONFIG.SENDER_NAME)}</p>`;
}

/* ===================== TIỆN ÍCH ===================== */

function getSpreadsheet_() {
  return CONFIG.SPREADSHEET_ID
    ? SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet_(name, headers) {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function log_(action, email, count, note) {
  getSheet_(CONFIG.SHEET_LOG, ['Thời gian', 'Hành động', 'Email', 'Số file', 'Ghi chú'])
    .appendRow([new Date(), action, email, count, note]);
}

function progress_(msg) {
  notify_(msg);
  SpreadsheetApp.flush();
}

function notify_(msg) {
  console.log(msg);
  try { getSpreadsheet_().toast(msg, 'Rà soát Drive', 8); } catch (e) { /* chạy từ trigger */ }
}

function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
