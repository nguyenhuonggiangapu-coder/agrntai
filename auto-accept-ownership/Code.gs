/**
 * Tự động chấp nhận yêu cầu chuyển quyền sở hữu file Google Drive.
 *
 * Cách tìm: chỉ xét file mà mình có quyền sửa nhưng chưa sở hữu
 * ('me' in writers and not 'me' in owners) — người chuyển quyền bắt buộc phải
 * cấp quyền Người chỉnh sửa trước, nên mọi yêu cầu đang chờ đều nằm trong nhóm này.
 * Trạng thái "đang chờ" đọc trực tiếp từ Drive (pendingOwner), không phụ thuộc email.
 */

const CONFIG = {
  // Chỉ nhận file từ những email/tên miền này. Để trống cả hai = nhận từ mọi người.
  ALLOWED_EMAILS: [],              // ví dụ: ['nhanvien1@gmail.com']
  ALLOWED_DOMAINS: [],             // ví dụ: ['mankai.edu.vn']
  DRY_RUN: false,                  // true = chỉ ghi nhật ký, chưa nhận thật (để thử)
  RUN_HOUR: 6,                     // chạy mỗi ngày 1 lần, khoảng 6h–7h sáng
  MAX_RUNTIME_MS: 4.5 * 60 * 1000, // mỗi lượt tối đa ~4,5 phút; chưa xong thì 1 phút sau tự chạy tiếp
  LOG_SHEET_NAME: 'Nhật ký nhận quyền',
};

const PROP_PAGE_TOKEN = 'pageToken';
const PROP_LOG_ID = 'logSpreadsheetId';
const MAIN_HANDLER = 'acceptPendingOwnerships';
const CONTINUE_HANDLER = 'continueAccepting';

/** Hàm chính — trigger gọi hàm này. */
function acceptPendingOwnerships() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // lượt trước chưa xong thì bỏ qua lượt này

  try {
    const start = Date.now();
    const props = PropertiesService.getScriptProperties();
    const me = Drive.About.get({ fields: 'user(permissionId,emailAddress)' }).user;
    let pageToken = props.getProperty(PROP_PAGE_TOKEN) || null;
    const stats = { checked: 0, pending: 0, accepted: 0, notAllowed: 0, errors: 0, apiCalls: 1 };

    do {
      let res;
      stats.apiCalls++;
      try {
        res = Drive.Files.list({
          q: "'me' in writers and not 'me' in owners and trashed = false",
          pageSize: 100,
          pageToken: pageToken || undefined,
          fields: 'nextPageToken, files(id, name, webViewLink, owners(emailAddress), permissions(id, pendingOwner))',
        });
      } catch (e) {
        if (!pageToken) throw e;
        pageToken = null; // token cũ hết hạn → quét lại từ đầu ở lượt sau
        break;
      }

      (res.files || []).forEach(f => {
        stats.checked++;
        if (!isPendingForMe_(f, me.permissionId)) return;
        stats.pending++;

        const ownerEmail = ((f.owners || [])[0] || {}).emailAddress || '';
        if (!isAllowedSender_(ownerEmail)) {
          stats.notAllowed++;
          log_('Bỏ qua (không nằm trong danh sách cho phép)', f, ownerEmail);
          return;
        }
        if (CONFIG.DRY_RUN) {
          log_('DRY_RUN: sẽ nhận', f, ownerEmail);
          return;
        }
        try {
          Drive.Permissions.update({ role: 'owner' }, f.id, me.permissionId, { transferOwnership: true });
          stats.accepted++;
          log_('Đã nhận quyền', f, ownerEmail);
        } catch (e) {
          stats.errors++;
          log_('Lỗi: ' + e.message, f, ownerEmail);
        }
      });

      pageToken = res.nextPageToken || null;
    } while (pageToken && Date.now() - start < CONFIG.MAX_RUNTIME_MS);

    deleteTriggers_(CONTINUE_HANDLER);
    if (pageToken) {
      props.setProperty(PROP_PAGE_TOKEN, pageToken);
      ScriptApp.newTrigger(CONTINUE_HANDLER).timeBased().after(60 * 1000).create();
    } else {
      props.deleteProperty(PROP_PAGE_TOKEN);
    }

    stats.seconds = Math.round((Date.now() - start) / 1000);
    console.log(JSON.stringify(stats) + (pageToken ? ' — CHƯA quét hết, 1 phút nữa tự chạy tiếp' : ' — đã quét hết'));
  } finally {
    flushLog_();
    lock.releaseLock();
  }
}

/** Lượt chạy tiếp khi Drive lớn, không xong trong một lượt. */
function continueAccepting() {
  acceptPendingOwnerships();
}

/** Quyền của mình trên file có đang ở trạng thái chờ nhận sở hữu không. */
function isPendingForMe_(file, myPermissionId) {
  let mine = (file.permissions || []).find(p => p.id === myPermissionId);
  if (!file.permissions) {
    // Drive không trả danh sách quyền khi mình không được chia sẻ tiếp → hỏi riêng quyền của mình.
    try {
      mine = Drive.Permissions.get(file.id, myPermissionId, { fields: 'id,pendingOwner' });
    } catch (e) {
      return false;
    }
  }
  return !!(mine && mine.pendingOwner);
}

function isAllowedSender_(email) {
  if (!CONFIG.ALLOWED_EMAILS.length && !CONFIG.ALLOWED_DOMAINS.length) return true;
  const e = email.toLowerCase();
  return CONFIG.ALLOWED_EMAILS.some(x => x.toLowerCase() === e) ||
    CONFIG.ALLOWED_DOMAINS.some(d => e.endsWith('@' + d.toLowerCase()));
}

/** Gom nhật ký trong bộ nhớ, cuối lượt ghi vào Sheet một lần (ghi từng dòng rất chậm). */
const LOG_BUFFER = [];

function log_(action, file, ownerEmail) {
  LOG_BUFFER.push([new Date(), action, file.name, ownerEmail, file.webViewLink || '']);
}

/** Ghi nhật ký vào một Google Sheet riêng (tự tạo lần đầu). */
function flushLog_() {
  if (!LOG_BUFFER.length) return;
  const props = PropertiesService.getScriptProperties();
  let ss;
  const id = props.getProperty(PROP_LOG_ID);
  try { ss = id && SpreadsheetApp.openById(id); } catch (e) { ss = null; }
  if (!ss) {
    ss = SpreadsheetApp.create(CONFIG.LOG_SHEET_NAME);
    ss.getSheets()[0].appendRow(['Thời gian', 'Kết quả', 'Tên file', 'Người chuyển', 'Link']);
    props.setProperty(PROP_LOG_ID, ss.getId());
  }
  const sheet = ss.getSheets()[0];
  sheet.getRange(sheet.getLastRow() + 1, 1, LOG_BUFFER.length, LOG_BUFFER[0].length).setValues(LOG_BUFFER);
  LOG_BUFFER.length = 0;
}

/**
 * Đếm trước số file cần kiểm tra (chỉ đọc, không nhận gì) và gợi ý tần suất chạy.
 * Rất nhẹ: mỗi lần gọi API đếm được 1.000 file.
 */
function countCandidates() {
  const start = Date.now();
  let count = 0, calls = 0, pageToken = null;
  do {
    const res = Drive.Files.list({
      q: "'me' in writers and not 'me' in owners and trashed = false",
      pageSize: 1000,
      pageToken: pageToken || undefined,
      fields: 'nextPageToken, files(id)',
    });
    calls++;
    count += (res.files || []).length;
    pageToken = res.nextPageToken || null;
  } while (pageToken);

  const estCalls = Math.max(1, Math.ceil(count / 100)) + 1;
  console.log(
    'Số file cần kiểm tra mỗi ngày: ' + count + '\n' +
    'Số lần gọi API mỗi ngày: ~' + estCalls + '\n' +
    'Thời gian chạy ước tính: ~' + Math.ceil(estCalls * 0.5) + ' giây/ngày (hạn mức miễn phí: 90 phút/ngày)\n' +
    'Đếm mất ' + Math.round((Date.now() - start) / 1000) + ' giây, ' + calls + ' lần gọi API'
  );
}

/** Chạy 1 lần để bật tự động. */
function installTrigger() {
  removeTrigger();
  ScriptApp.newTrigger(MAIN_HANDLER).timeBased().everyDays(1).atHour(CONFIG.RUN_HOUR).create();
  acceptPendingOwnerships();
}

function removeTrigger() {
  deleteTriggers_(MAIN_HANDLER);
  deleteTriggers_(CONTINUE_HANDLER);
  PropertiesService.getScriptProperties().deleteProperty(PROP_PAGE_TOKEN);
}

function deleteTriggers_(handler) {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === handler)
    .forEach(t => ScriptApp.deleteTrigger(t));
}

/** Mở link sheet nhật ký (xem trong Nhật ký thực thi). */
function showLogLink() {
  const id = PropertiesService.getScriptProperties().getProperty(PROP_LOG_ID);
  console.log(id ? 'https://docs.google.com/spreadsheets/d/' + id : 'Chưa có nhật ký (chưa gặp yêu cầu nào).');
}
