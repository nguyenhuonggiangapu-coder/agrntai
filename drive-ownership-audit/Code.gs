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

  TIME_LIMIT_MS: 5 * 60 * 1000, // Apps Script giới hạn 6 phút / lần chạy
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
    .addItem('1. Quét Drive ngay', 'scanDrive')
    .addItem('2. Gửi email nhắc ngay', 'sendReminders')
    .addSeparator()
    .addItem('Bật chạy tự động hằng ngày', 'setupDailyTrigger')
    .addItem('Tắt chạy tự động', 'removeTriggers')
    .addToUi();
}

/** Việc chạy hằng ngày: quét rồi nhắc. */
function runDaily() {
  scanDrive();
  sendReminders();
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

/* ===================== BƯỚC 1 + 2: QUÉT ===================== */

function scanDrive() {
  const startedAt = Date.now();
  getSheet_(CONFIG.SHEET_FILES, HEADERS); // tạo tab ngay để thấy script đã chạy
  progress_('Bước 1/3: đang đọc các thư mục bạn sở hữu...');

  // 1) Thư mục mình sở hữu (ở bất kỳ đâu trong Drive) = điểm xuất phát.
  const folderName = {};
  const scope = new Set();
  forEachFile_(
    "'me' in owners and mimeType = '" + FOLDER_MIME + "' and trashed = false",
    'id,name',
    startedAt,
    f => { folderName[f.id] = f.name; scope.add(f.id); }
  );

  progress_(`Bước 2/3: ${scope.size} thư mục của bạn. Đang tìm file của người khác bên trong...`);

  // 2) Chỉ hỏi Drive các mục KHÔNG do mình sở hữu nằm trong các thư mục đó.
  //    Thư mục con của người khác -> đưa vào phạm vi và quét tiếp vòng sau.
  const found = [];
  let frontier = Array.from(scope);
  while (frontier.length) {
    const next = [];
    for (let i = 0; i < frontier.length; i += PARENT_CHUNK) {
      const parents = frontier.slice(i, i + PARENT_CHUNK).map(id => `'${id}' in parents`).join(' or ');
      forEachFile_(
        `not 'me' in owners and trashed = false and (${parents})`,
        'id,name,mimeType,parents,webViewLink,owners(displayName,emailAddress)',
        startedAt,
        f => {
          if (f.owners && f.owners.length) found.push(f);
          if (f.mimeType === FOLDER_MIME && !scope.has(f.id)) {
            scope.add(f.id);
            folderName[f.id] = f.name;
            next.push(f.id);
          }
        }
      );
    }
    frontier = next;
  }

  progress_(`Bước 3/3: tìm thấy ${found.length} mục. Đang ghi vào sheet...`);

  // 3) Ghi vào Sheet.
  const result = upsertRows_(found, folderName);
  log_('Quét', '', found.length,
    `${scope.size} thư mục trong phạm vi; mới: ${result.added}; đã xử lý: ${result.done}`);
  notify_(`Quét xong: ${found.length} mục không thuộc sở hữu của bạn (mới: ${result.added}).`);
}

const PARENT_CHUNK = 40; // số thư mục gộp trong 1 lần hỏi Drive

/** Duyệt từng trang kết quả, không giữ toàn bộ trong bộ nhớ. */
function forEachFile_(q, fileFields, startedAt, callback) {
  let pageToken;
  do {
    if (Date.now() - startedAt > CONFIG.TIME_LIMIT_MS) {
      throw new Error('Drive quá lớn, vượt giới hạn thời gian 1 lần chạy. Xem mục "Giới hạn" trong README.');
    }
    const res = Drive.Files.list({
      q: q,
      pageSize: 1000,
      pageToken: pageToken,
      fields: 'nextPageToken, files(' + fileFields + ')',
    });
    (res.files || []).forEach(callback);
    pageToken = res.nextPageToken;
  } while (pageToken);
}

function upsertRows_(found, folderName) {
  const sheet = getSheet_(CONFIG.SHEET_FILES, HEADERS);
  const now = new Date();
  const rows = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length).getValues()
    : [];
  const rowById = {};
  rows.forEach((r, i) => (rowById[r[COL['File ID']]] = i));

  const seen = new Set();
  let added = 0;
  found.forEach(f => {
    const owner = f.owners[0];
    const folders = (f.parents || []).map(p => folderName[p] || p).join(', ');
    const type = f.mimeType === FOLDER_MIME ? 'Thư mục' : 'File';
    seen.add(f.id);

    if (f.id in rowById) {
      const r = rows[rowById[f.id]];
      r[COL['Tên file']] = f.name;
      r[COL['Loại']] = type;
      r[COL['Link']] = f.webViewLink;
      r[COL['Thư mục chứa']] = folders;
      r[COL['Quét gần nhất']] = now;
      // Đổi chủ sở hữu (vd chuyển cho người thứ 3) -> tính lại từ đầu.
      if (String(r[COL['Email chủ sở hữu']]).toLowerCase() !== (owner.emailAddress || '').toLowerCase()) {
        r[COL['Nhắc gần nhất']] = '';
        r[COL['Số lần nhắc']] = 0;
      }
      r[COL['Chủ sở hữu']] = owner.displayName || '';
      r[COL['Email chủ sở hữu']] = owner.emailAddress || '';
      if (r[COL['Trạng thái']] === STATUS.DONE) r[COL['Trạng thái']] = STATUS.PENDING;
    } else {
      rows.push([
        f.id, f.name, type, f.webViewLink, owner.displayName || '', owner.emailAddress || '',
        folders, now, now, STATUS.PENDING, '', 0,
      ]);
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
  return { added: added, done: done };
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
  const list = files.map(r =>
    `<tr><td style="padding:4px 8px"><a href="${esc_(r[COL['Link']])}">${esc_(r[COL['Tên file']])}</a></td>` +
    `<td style="padding:4px 8px;color:#555">${esc_(r[COL['Thư mục chứa']])}</td></tr>`
  ).join('');
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
