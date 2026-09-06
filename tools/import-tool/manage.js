const { renderNav, NAV_STYLES } = require('./nav');

function renderManagePage() {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TuRu - פעילויות</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fredoka:wght@600;700&family=Assistant:wght@400;500;600;700;800&display=swap">
<style>
  * { box-sizing: border-box; }
  ${NAV_STYLES}
  body {
    margin: 0; min-height: 100vh;
    background: oklch(0.985 0.004 230);
    font-family: 'Assistant', 'Segoe UI', Arial, sans-serif;
    color: oklch(0.22 0.02 240);
  }
  .wrap { max-width: 900px; margin: 0 auto; padding: 32px 20px 60px; }
  .logo-lockup { display: flex; align-items: center; gap: 8px; direction: ltr; margin-bottom: 4px; }
  .logo { font-family: 'Fredoka', 'Assistant', sans-serif; font-size: 26px; font-weight: 700; }
  .logo .wab { color: oklch(0.3 0.03 235); }
  .logo .bit { color: oklch(0.52 0.11 225); }
  .top-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 28px; }
  h1 { font-size: 16px; font-weight: 700; color: oklch(0.4 0.02 235); margin: 0; }
  .back-link { font-size: 13px; font-weight: 700; color: oklch(0.52 0.11 225); text-decoration: none; }

  .tab-row { display: flex; gap: 4px; border-bottom: 2px solid oklch(0.9 0.01 230); margin: 8px 0 20px; flex-wrap: wrap; }
  .tab-btn {
    border: none; background: none; color: oklch(0.5 0.02 235); font-weight: 700; font-size: 14px;
    padding: 10px 16px; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -2px;
  }
  .tab-btn.active { color: oklch(0.52 0.11 225); border-bottom-color: oklch(0.52 0.11 225); }
  .tab-count { font-size: 11.5px; font-weight: 700; color: oklch(0.5 0.02 235); margin-inline-start: 4px; }
  .tab-btn.active .tab-count { color: oklch(0.52 0.11 225); }
  .photo-skipped-star { font-size: 12px; margin-inline-start: 4px; }

  .tools-row { display: flex; gap: 10px; margin-bottom: 18px; flex-wrap: wrap; }
  .dup-check-btn {
    border: 1px solid oklch(0.88 0.01 230); background: oklch(1 0 0); color: oklch(0.4 0.02 235);
    font-weight: 700; font-size: 13px; border-radius: 999px; padding: 8px 16px; cursor: pointer;
  }
  .dup-check-btn:disabled { opacity: 0.5; cursor: default; }
  .dup-check-btn.confirming { border-color: oklch(0.5 0.18 25); background: oklch(0.5 0.18 25); color: white; }
  .geocode-missing-status { font-size: 12.5px; color: oklch(0.5 0.02 235); align-self: center; }
  .dup-summary { font-size: 13.5px; color: oklch(0.5 0.02 235); margin-bottom: 10px; }
  .dup-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 4px; }
  .select-all-wrap { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14px; cursor: pointer; }
  .select-box { width: 18px; height: 18px; flex-shrink: 0; accent-color: oklch(0.52 0.11 225); cursor: pointer; }
  .delete-selected-btn {
    border: none; background: oklch(0.5 0.18 25); color: white; font-weight: 700; font-size: 13.5px;
    border-radius: 999px; padding: 10px 18px; cursor: pointer; white-space: nowrap;
  }
  .delete-selected-btn:disabled { opacity: 0.4; cursor: default; }
  .approve-selected-btn {
    border: none; background: oklch(0.45 0.12 150); color: white; font-weight: 700; font-size: 13.5px;
    border-radius: 999px; padding: 10px 18px; cursor: pointer; white-space: nowrap;
  }
  .approve-selected-btn:disabled { opacity: 0.4; cursor: default; }
  .status-row-select { width: 17px; height: 17px; accent-color: oklch(0.52 0.11 225); cursor: pointer; flex-shrink: 0; margin-inline-end: 8px; }

  .toolbar {
    background: oklch(1 0 0); border: 1px solid oklch(0.9 0.01 230); border-radius: 16px;
    padding: 16px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
    box-shadow: 0 4px 16px oklch(0.3 0.02 230 / 0.06); margin-bottom: 8px;
  }
  .toolbar input[type=text] {
    flex: 1; min-width: 160px; border: 1px solid oklch(0.88 0.01 230); border-radius: 10px;
    padding: 10px 14px; font-family: inherit; font-size: 13.5px;
  }
  .toolbar select {
    border: 1px solid oklch(0.88 0.01 230); border-radius: 10px; padding: 10px 12px;
    font-family: inherit; font-size: 13px; background: white;
  }
  .status { margin: 12px 2px; font-size: 13.5px; color: oklch(0.5 0.02 235); }
  .status.error { color: oklch(0.5 0.18 25); font-weight: 600; }

  .region-section { margin-top: 22px; }
  .region-header {
    display: flex; align-items: center; justify-content: space-between; cursor: pointer;
    padding: 10px 4px; border-bottom: 2px solid oklch(0.52 0.11 225 / 0.25);
  }
  .region-title { font-family: 'Fredoka', sans-serif; font-size: 16px; font-weight: 600; color: oklch(0.3 0.03 235); }
  .region-count { font-size: 12.5px; color: oklch(0.5 0.02 235); font-weight: 600; }
  .region-body { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
  .region-body.collapsed { display: none; }

  .row {
    background: oklch(1 0 0); border: 1px solid oklch(0.9 0.01 230); border-radius: 14px;
    padding: 12px 16px; box-shadow: 0 2px 10px oklch(0.3 0.02 230 / 0.05);
  }
  .row-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; cursor: pointer; }
  .row-select { width: 17px; height: 17px; accent-color: oklch(0.52 0.11 225); cursor: pointer; flex-shrink: 0; }
  .bulk-select-bar {
    display: none; align-items: center; justify-content: space-between; gap: 12px;
    background: oklch(1 0 0); border: 1px solid oklch(0.9 0.01 230); border-radius: 14px;
    padding: 12px 16px; margin-bottom: 14px; position: sticky; top: 12px; z-index: 5;
    box-shadow: 0 4px 16px oklch(0.3 0.02 230 / 0.08);
  }
  .bulk-select-bar.visible { display: flex; flex-wrap: wrap; }
  .bulk-select-count { font-weight: 700; font-size: 13.5px; color: oklch(0.4 0.02 235); }
  .bulk-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .bulk-select {
    border: 1px solid oklch(0.88 0.01 230); border-radius: 8px; padding: 7px 9px;
    font-family: inherit; font-size: 12.5px; background: white; color: oklch(0.3 0.02 235);
  }
  .bulk-approve-btn {
    border: none; background: oklch(0.45 0.12 150); color: white; font-weight: 700; font-size: 13px;
    border-radius: 999px; padding: 9px 20px; cursor: pointer; white-space: nowrap;
  }
  .bulk-approve-btn:disabled { opacity: 0.5; cursor: default; }
  .bulk-verify-btn {
    border: none; background: oklch(0.65 0.15 60); color: white; font-weight: 700; font-size: 13px;
    border-radius: 999px; padding: 9px 16px; cursor: pointer; white-space: nowrap;
  }
  .bulk-verify-btn:disabled { opacity: 0.5; cursor: default; }
  .issue-badge {
    display: inline-block; font-size: 10px; font-weight: 700; border-radius: 999px; padding: 2px 7px;
    background: oklch(0.95 0.05 25); color: oklch(0.5 0.15 25); margin-inline-end: 3px;
  }
  .stale-badge {
    display: inline-block; font-size: 10px; font-weight: 700; border-radius: 999px; padding: 2px 7px;
    background: oklch(0.96 0.05 70); color: oklch(0.5 0.13 60);
  }
  .verified-meta { font-size: 11px; color: oklch(0.55 0.02 235); }
  .verify-row-btn {
    border: 1px solid oklch(0.88 0.01 230); background: white; color: oklch(0.4 0.02 235);
    font-weight: 700; font-size: 10.5px; border-radius: 999px; padding: 3px 9px; cursor: pointer;
  }
  .row-title { font-size: 14.5px; font-weight: 800; flex: 1; min-width: 140px; }
  .row-meta { font-size: 12px; color: oklch(0.5 0.02 235); }
  .row-actions { display: flex; gap: 6px; }
  .status-badge { display: inline-block; font-size: 11px; font-weight: 700; border-radius: 999px; padding: 3px 10px; }
  .status-badge.pending { background: oklch(0.95 0.05 90); color: oklch(0.5 0.12 80); }
  .status-badge.approved { background: oklch(0.93 0.06 150); color: oklch(0.4 0.12 150); }
  .status-badge.rejected { background: oklch(0.94 0.05 25); color: oklch(0.5 0.15 25); }
  .status-badge.archived { background: oklch(0.92 0.01 260); color: oklch(0.45 0.02 260); }
  .cat-badge {
    display: inline-block; font-size: 11px; font-weight: 700; color: oklch(0.52 0.11 225);
    background: oklch(0.95 0.02 225); border-radius: 7px; padding: 3px 9px;
  }
  .icon-btn {
    border: 1px solid oklch(0.88 0.01 230); background: oklch(1 0 0); color: oklch(0.4 0.02 235);
    font-weight: 700; font-size: 12px; border-radius: 999px; padding: 6px 14px; cursor: pointer; white-space: nowrap;
  }
  .icon-btn.danger { border-color: oklch(0.5 0.18 25); color: oklch(0.5 0.18 25); }
  .icon-btn.approve-btn { border-color: oklch(0.45 0.12 150); color: oklch(0.4 0.12 150); }
  .icon-btn.danger.confirming { background: oklch(0.5 0.18 25); color: white; }
  .icon-btn:disabled { opacity: 0.5; cursor: default; }

  .edit-form { margin-top: 14px; padding-top: 14px; border-top: 1px solid oklch(0.93 0.01 230); display: flex; flex-direction: column; gap: 12px; }
  .field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; }
  .field-grid.wide { grid-template-columns: 1fr; }
  .field-block label { display: block; font-size: 11.5px; font-weight: 700; color: oklch(0.5 0.02 235); margin-bottom: 4px; }
  .field-block input[type=text], .field-block input[type=number], .field-block select, .field-block textarea {
    width: 100%; border: 1px solid oklch(0.88 0.01 230); border-radius: 9px; padding: 8px 10px;
    font-family: inherit; font-size: 13px; background: white;
  }
  .field-block textarea { min-height: 60px; resize: vertical; }
  .tag-group { display: flex; flex-wrap: wrap; gap: 6px; }
  .tag-check { display: flex; align-items: center; gap: 4px; font-size: 12px; border: 1px solid oklch(0.88 0.01 230); border-radius: 999px; padding: 4px 10px; cursor: pointer; }
  .tag-check input { margin: 0; }
  .form-actions { display: flex; gap: 10px; align-items: center; }
  .save-btn {
    border: none; background: oklch(0.52 0.11 225); color: white; font-weight: 700; font-size: 13px;
    border-radius: 999px; padding: 9px 20px; cursor: pointer;
  }
  .save-btn:disabled { opacity: 0.5; cursor: default; }
  .cancel-btn {
    border: 1px solid oklch(0.88 0.01 230); background: white; color: oklch(0.4 0.02 235);
    font-weight: 700; font-size: 13px; border-radius: 999px; padding: 9px 18px; cursor: pointer;
  }
  .edit-status { font-size: 12.5px; color: oklch(0.5 0.02 235); }
  .edit-status.success { color: oklch(0.45 0.1 150); font-weight: 700; }
  .geo-row { display: flex; align-items: center; gap: 10px; margin: 4px 0 6px; flex-wrap: wrap; }
  .geo-status { font-size: 12px; color: oklch(0.5 0.02 235); }
  .geocode-btn {
    border: 1px solid oklch(0.88 0.01 230); background: white; color: oklch(0.4 0.02 235);
    font-weight: 700; font-size: 12px; border-radius: 999px; padding: 5px 12px; cursor: pointer;
  }
  .geocode-btn:disabled { opacity: 0.5; cursor: default; }
  .edit-photo-row { display: flex; flex-wrap: wrap; gap: 10px; }
  .edit-photo-item { position: relative; width: 64px; height: 64px; }
  .edit-photo-thumb { width: 64px; height: 64px; border-radius: 8px; object-fit: cover; border: 1px solid oklch(0.9 0.01 230); cursor: pointer; display: block; }
  .edit-photo-delete {
    position: absolute; top: -6px; left: -6px; width: 20px; height: 20px; border-radius: 50%;
    border: none; background: oklch(0.5 0.18 25); color: white; font-size: 11px; line-height: 1; cursor: pointer;
    display: flex; align-items: center; justify-content: center; padding: 0;
  }
  .edit-photo-delete:disabled { opacity: 0.5; cursor: default; }
  .edit-status.error { color: oklch(0.5 0.18 25); font-weight: 600; }
  .source-link { font-size: 11.5px; font-weight: 700; color: oklch(0.52 0.11 225); text-decoration: none; direction: ltr; }
  .row.is-removed { display: none; }
  .benefit-rows { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
  .benefit-row {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    border: 1px solid oklch(0.9 0.01 230); border-radius: 9px; padding: 7px 10px;
  }
  .benefit-row-text { font-size: 12.5px; flex: 1; min-width: 160px; }
  .benefit-form { border: 1px dashed oklch(0.85 0.01 230); border-radius: 9px; padding: 10px; margin-top: 6px; display: flex; flex-direction: column; gap: 10px; }

  .photos-section {
    background: oklch(1 0 0); border: 1px solid oklch(0.9 0.01 230); border-radius: 16px;
    padding: 16px; margin-bottom: 22px; box-shadow: 0 4px 16px oklch(0.3 0.02 230 / 0.06);
  }
  .photos-title { font-size: 14.5px; font-weight: 800; margin-bottom: 12px; }
  .photo-card {
    display: flex; align-items: center; gap: 12px; padding: 10px 0;
    border-top: 1px solid oklch(0.95 0.01 230);
  }
  .photo-card:first-of-type { border-top: none; }
  .photo-candidate {
    display: flex; align-items: center; gap: 10px; margin-top: 10px; padding-top: 10px;
    border-top: 1px dashed oklch(0.85 0.06 80);
  }
  .photo-candidate-thumb { width: 56px; height: 56px; border-radius: 8px; object-fit: cover; flex-shrink: 0; background: oklch(0.95 0.01 230); }
  .photo-candidate-label { font-size: 12px; color: oklch(0.5 0.12 80); flex: 1; }
  .photo-candidate-approve { border-color: oklch(0.45 0.12 150); color: oklch(0.4 0.12 150); }
  .photo-thumb { width: 72px; height: 72px; border-radius: 10px; object-fit: cover; flex-shrink: 0; background: oklch(0.95 0.01 230); }
  .photo-info { flex: 1; min-width: 0; font-size: 12.5px; color: oklch(0.4 0.02 235); }
  .photo-actions { display: flex; gap: 6px; }
  .photo-approve-btn {
    border: 1px solid oklch(0.45 0.12 150); color: oklch(0.4 0.12 150); background: white;
    font-weight: 700; font-size: 12px; border-radius: 999px; padding: 6px 14px; cursor: pointer;
  }
  .photo-reject-btn {
    border: 1px solid oklch(0.5 0.18 25); color: oklch(0.5 0.18 25); background: white;
    font-weight: 700; font-size: 12px; border-radius: 999px; padding: 6px 14px; cursor: pointer;
  }
  .photo-approve-btn:disabled, .photo-reject-btn:disabled { opacity: 0.5; cursor: default; }

  .reports-section {
    background: oklch(1 0 0); border: 1px solid oklch(0.9 0.01 230); border-radius: 16px;
    padding: 16px; margin-bottom: 22px; box-shadow: 0 4px 16px oklch(0.3 0.02 230 / 0.06);
  }
  .reports-title { font-size: 14.5px; font-weight: 800; margin-bottom: 12px; }
  .report-card { padding: 10px 0; border-top: 1px solid oklch(0.95 0.01 230); }
  .report-card:first-of-type { border-top: none; }
  .report-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .report-activity-name { font-weight: 800; font-size: 13.5px; flex: 1; min-width: 140px; }
  .report-date { font-size: 11.5px; color: oklch(0.5 0.02 235); }
  .report-reason { font-size: 12.5px; color: oklch(0.4 0.02 235); margin-top: 6px; background: oklch(0.97 0.01 90); border-radius: 8px; padding: 8px 10px; }
  .report-resolve-btn {
    border: 1px solid oklch(0.45 0.12 150); color: oklch(0.4 0.12 150); background: white;
    font-weight: 700; font-size: 12px; border-radius: 999px; padding: 6px 14px; cursor: pointer;
  }
  .report-resolve-btn:disabled { opacity: 0.5; cursor: default; }

  /* --- "דורש טיפול" (במקור עמוד "איכות נתונים" נפרד - מוזג לכאן) --- */
  .action-status { font-size: 12.5px; color: oklch(0.5 0.02 235); }
  .section { margin-top: 26px; }
  .section-title { font-size: 15px; font-weight: 800; margin: 0 0 4px; color: oklch(0.3 0.02 235); }
  .section-sub { font-size: 12.5px; color: oklch(0.5 0.02 235); margin-bottom: 12px; }
  .empty-note { font-size: 13px; color: oklch(0.5 0.02 235); padding: 10px 2px; }

  .dup-group {
    background: oklch(1 0 0); border: 1px solid oklch(0.9 0.01 230); border-radius: 14px;
    padding: 14px 16px; margin-bottom: 12px;
  }
  .dup-group-title { font-size: 14.5px; font-weight: 800; margin-bottom: 2px; }
  .dup-group-meta { font-size: 12px; color: oklch(0.5 0.02 235); margin-bottom: 10px; }
  .dup-item {
    display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0;
    font-size: 12.5px; color: oklch(0.4 0.02 235); border-top: 1px solid oklch(0.95 0.01 230); flex-wrap: wrap;
  }
  .dup-item:first-of-type { border-top: none; }
  .dup-item-keeper-badge {
    font-size: 10.5px; font-weight: 700; border-radius: 999px; padding: 2px 8px;
    background: oklch(0.94 0.06 150); color: oklch(0.4 0.12 150); margin-inline-start: 6px;
  }
  .dup-item-actions { display: flex; gap: 6px; }
  .mini-btn {
    border: 1px solid oklch(0.88 0.01 230); background: white; color: oklch(0.4 0.02 235);
    font-weight: 700; font-size: 11.5px; border-radius: 999px; padding: 5px 11px; cursor: pointer; white-space: nowrap;
  }
  .mini-btn.primary { background: oklch(0.52 0.11 225); border-color: oklch(0.52 0.11 225); color: white; }
  .mini-btn.danger { border-color: oklch(0.5 0.18 25); color: oklch(0.5 0.18 25); }
  .mini-btn:disabled { opacity: 0.5; cursor: default; }
  .merge-preview {
    margin-top: 8px; padding: 10px 12px; background: oklch(0.97 0.02 225); border-radius: 10px;
    font-size: 12px; line-height: 1.6;
  }
  .merge-preview b { color: oklch(0.3 0.02 235); }

  .issue-group { margin-bottom: 22px; }
  .issue-group-head {
    display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;
    margin-bottom: 8px;
  }
  .issue-group-title { font-size: 13px; font-weight: 800; color: oklch(0.4 0.02 235); }
  .issue-group-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .issue-select-all-wrap { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; color: oklch(0.5 0.02 235); cursor: pointer; }
  .issue-select-box { width: 15px; height: 15px; accent-color: oklch(0.52 0.11 225); cursor: pointer; }
  .issue-row {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    background: oklch(1 0 0); border: 1px solid oklch(0.9 0.01 230); border-radius: 10px;
    padding: 9px 13px; margin-bottom: 6px; font-size: 12.5px; cursor: pointer;
  }
  .issue-row:hover { border-color: oklch(0.75 0.05 225); }
  .issue-row-left { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
  .issue-row-actions { display: flex; align-items: center; gap: 6px; }
  .issue-row-edit {
    font-size: 11.5px; font-weight: 700; color: white; background: oklch(0.52 0.11 225);
    text-decoration: none; border-radius: 999px; padding: 5px 12px; white-space: nowrap;
  }
  .issue-row-dismiss {
    font-size: 11.5px; font-weight: 700; color: oklch(0.5 0.02 235); background: white;
    border: 1px solid oklch(0.88 0.01 230); border-radius: 999px; padding: 5px 10px; cursor: pointer; white-space: nowrap;
  }
  .issue-row-dismiss:disabled { opacity: 0.5; cursor: default; }
</style>
</head>
<body>
<div class="wrap">
  <div class="top-row">
    <div>
      <div class="logo-lockup">
        <svg width="24" height="24" viewBox="0 0 24 24">
          <ellipse cx="9" cy="7" rx="3" ry="7.5" fill="oklch(0.62 0.16 40)" transform="rotate(-18 9 7)"/>
          <ellipse cx="15" cy="7" rx="3" ry="7.5" fill="oklch(0.52 0.11 225)" transform="rotate(18 15 7)"/>
        </svg>
        <div class="logo"><span class="wab">WAB</span><span class="bit">BIT</span></div>
      </div>
      <h1>ניהול פעילויות</h1>
    </div>
  </div>
  ${renderNav('activities')}

  <div id="photosSection" class="photos-section" style="display: none;">
    <div class="photos-title">תמונות ממתינות לאישור</div>
    <div id="photosList"></div>
  </div>

  <div id="reportsSection" class="reports-section" style="display: none;">
    <div class="reports-title">דיווחים על פעילויות</div>
    <div id="reportsList"></div>
  </div>

  <div class="tab-row">
    <button class="tab-btn active" id="tabBtnActivities" data-tab="activities">פעילויות</button>
    <button class="tab-btn" id="tabBtnPending" data-tab="pending">פעילויות לאישור<span class="tab-count" id="tabPendingCount"></span></button>
    <button class="tab-btn" id="tabBtnMissingPhotos" data-tab="missingPhotos">פעילויות ללא תמונה - לטיפול<span class="tab-count" id="tabMissingPhotosCount"></span></button>
    <button class="tab-btn" id="tabBtnAttention" data-tab="attention">🔴 דורש טיפול<span class="tab-count" id="tabAttentionCount"></span></button>
  </div>

  <div id="tabActivities" class="tab-panel">
    <div class="toolbar">
      <input id="search" type="text" placeholder="חיפוש לפי שם...">
      <select id="statusFilter">
        <option value="approved">מאושר (פעיל)</option>
        <option value="">כל הסטטוסים</option>
        <option value="pending">ממתין</option>
        <option value="archived">בארכיון</option>
        <option value="rejected">נדחה</option>
      </select>
      <select id="categoryFilter"><option value="">כל הקטגוריות</option></select>
    </div>
    <div id="bulkSelectBar" class="bulk-select-bar">
      <span id="bulkSelectCount" class="bulk-select-count">0 פעילויות מסומנות</span>
      <div class="bulk-actions">
        <button id="bulkApproveBtn" class="bulk-approve-btn" disabled>אשר</button>
        <select id="bulkCategorySelect" class="bulk-select"><option value="">שנה קטגוריה ל...</option></select>
        <select id="bulkRegionSelect" class="bulk-select"><option value="">שנה אזור ל...</option></select>
        <select id="bulkVerifyDays" class="bulk-select">
          <option value="">אמת - בלי תזכורת</option>
          <option value="30">אמת - בדוק שוב בעוד 30 יום</option>
          <option value="60">אמת - בדוק שוב בעוד 60 יום</option>
          <option value="90">אמת - בדוק שוב בעוד 90 יום</option>
        </select>
        <button id="bulkVerifyBtn" class="bulk-verify-btn" disabled>✓ אמת</button>
        <button id="bulkDeleteBtn" class="delete-selected-btn" disabled>מחק</button>
      </div>
    </div>
    <div id="status" class="status">טוען...</div>
    <div id="regions"></div>
  </div>

  <div id="tabPending" class="tab-panel" style="display: none;">
    <div id="statusSummary" class="dup-summary"></div>
    <div class="dup-bar">
      <label class="select-all-wrap">
        <input type="checkbox" id="statusSelectAll" class="select-box">
        <span>סמן הכל (הממתינות לאישור)</span>
      </label>
      <button id="approveSelected" class="approve-selected-btn" disabled>אשר את כל הפעילויות המסומנות</button>
    </div>
    <div id="statusList"></div>
  </div>

  <div id="tabMissingPhotos" class="tab-panel" style="display: none;">
    <div id="missingPhotosSummary" class="dup-summary"></div>
    <div class="dup-bar">
      <label class="select-all-wrap">
        <input type="checkbox" id="missingPhotosSelectAll" class="select-box">
        <span>סמן הכל (ללא תמונה)</span>
      </label>
    </div>
    <div id="missingPhotosBulkBar" class="bulk-select-bar">
      <span id="missingPhotosBulkCount" class="bulk-select-count">0 פעילויות מסומנות</span>
      <button id="missingPhotosBulkSearchBtn" class="bulk-approve-btn" disabled>חפש תמונה לכל הפעילויות המסומנות</button>
    </div>
    <div id="missingPhotosList"></div>
  </div>

  <div id="tabAttention" class="tab-panel" style="display: none;">
    <div class="tools-row">
      <button id="cleanupExpired" class="dup-check-btn">🧹 ניקוי פעילויות שפג תוקפן</button>
      <button id="checkLinks" class="dup-check-btn">🔗 בדוק קישורים שבורים</button>
      <button id="geocodeMissing" class="dup-check-btn">🌍 השלם קואורדינטות חסרות למפה</button>
      <span id="attentionToolsStatus" class="action-status"></span>
    </div>
    <span id="cleanupExpiredStatus" class="geocode-missing-status"></span>

    <div class="section">
      <div class="section-title">כפילויות אפשריות</div>
      <div class="section-sub">התאמה מדויקת (שם+מיקום זהים) או קרבה גיאוגרפית עם שם דומה. הפעילות הראשונה בכל קבוצה תישמר במיזוג.</div>
      <div id="dupList"></div>
    </div>

    <div class="section">
      <div class="section-title">מידע חסר</div>
      <div id="issuesList"></div>
    </div>

    <div class="section">
      <div class="section-title">קישורים שבורים</div>
      <div id="brokenLinksList"></div>
    </div>
  </div>

  <input type="file" id="manualPhotoInput" accept="image/*" style="display: none;">
</div>

<script src="/admin-shared.js"></script>
<script>
  const $search = document.getElementById('search');
  const $statusFilter = document.getElementById('statusFilter');
  const $categoryFilter = document.getElementById('categoryFilter');
  const $status = document.getElementById('status');
  const $regions = document.getElementById('regions');
  const $photosSection = document.getElementById('photosSection');
  const $photosList = document.getElementById('photosList');
  const $reportsSection = document.getElementById('reportsSection');
  const $reportsList = document.getElementById('reportsList');
  const $missingPhotosSummary = document.getElementById('missingPhotosSummary');
  const $missingPhotosList = document.getElementById('missingPhotosList');
  const $missingPhotosSelectAll = document.getElementById('missingPhotosSelectAll');
  const $missingPhotosBulkBar = document.getElementById('missingPhotosBulkBar');
  const $missingPhotosBulkCount = document.getElementById('missingPhotosBulkCount');
  const $missingPhotosBulkSearchBtn = document.getElementById('missingPhotosBulkSearchBtn');
  const $manualPhotoInput = document.getElementById('manualPhotoInput');
  const $bulkSelectBar = document.getElementById('bulkSelectBar');
  const $bulkSelectCount = document.getElementById('bulkSelectCount');
  const $bulkApproveBtn = document.getElementById('bulkApproveBtn');
  const $bulkCategorySelect = document.getElementById('bulkCategorySelect');
  const $bulkRegionSelect = document.getElementById('bulkRegionSelect');
  const $bulkVerifyDays = document.getElementById('bulkVerifyDays');
  const $bulkVerifyBtn = document.getElementById('bulkVerifyBtn');
  const $bulkDeleteBtn = document.getElementById('bulkDeleteBtn');
  const $cleanupExpired = document.getElementById('cleanupExpired');
  const $cleanupExpiredStatus = document.getElementById('cleanupExpiredStatus');
  const $statusSummary = document.getElementById('statusSummary');
  const $statusList = document.getElementById('statusList');
  const $statusSelectAll = document.getElementById('statusSelectAll');
  const $approveSelected = document.getElementById('approveSelected');
  const $checkLinks = document.getElementById('checkLinks');
  const $geocodeMissing = document.getElementById('geocodeMissing');
  const $attentionToolsStatus = document.getElementById('attentionToolsStatus');
  const $dupList = document.getElementById('dupList');
  const $issuesList = document.getElementById('issuesList');
  const $brokenLinksList = document.getElementById('brokenLinksList');
  const $tabAttentionCount = document.getElementById('tabAttentionCount');
  const $tabButtons = document.querySelectorAll('.tab-btn');
  const $tabPanels = {
    activities: document.getElementById('tabActivities'),
    pending: document.getElementById('tabPending'),
    missingPhotos: document.getElementById('tabMissingPhotos'),
    attention: document.getElementById('tabAttention'),
  };
  const $tabPendingCount = document.getElementById('tabPendingCount');
  const $tabMissingPhotosCount = document.getElementById('tabMissingPhotosCount');

  let allActivities = [];
  let activityById = new Map();
  let options = null;
  let collapsedRegions = new Set();
  let activeQuickFilter = null; // 'pending'|'issues'|'stale'|'no_photo'|null - מגיע מ-?filter= בקישור מהדשבורד
  let selectedIds = new Set();
  let selectedStatusIds = new Set();
  let missingPhotoSelectedIds = new Set();
  let manualPhotoTargetId = null;

  // "דורש טיפול" (מוזג מעמוד "איכות נתונים" לשעבר) - state ולוגיקה
  const ISSUE_ORDER = ['missing_age', 'missing_price', 'missing_address', 'missing_coords', 'missing_hours', 'broken_link', 'no_photo'];
  const SEARCHABLE_ISSUE_CODES = new Set(['missing_age', 'missing_price', 'missing_address', 'missing_hours']);
  const issueSelectedIds = new Map(ISSUE_ORDER.map((c) => [c, new Set()]));
  const dismissedIssueIds = new Map();

  const statusLabels = { pending: 'ממתין לאישור', approved: 'מאושר (פעיל)', rejected: 'נדחה', archived: 'בארכיון' };
  const entityTypeLabels = { 'מקום_קבוע': 'מקום קבוע', 'פעילות': 'פעילות/חוג', 'אירוע_קבוע': 'אירוע קבוע', 'אירוע': 'אירוע חד פעמי' };
  const priceTypeLabels = { free: 'חינם', fixed: 'מחיר קבוע', range: 'טווח מחירים' };
  const indoorOutdoorLabels = { indoor: 'בתוך מבנה', outdoor: 'בחוץ', both: 'בפנים ובחוץ' };
  const bookingLabels = { none: 'אין צורך להזמין', walk_in: 'ללא הרשמה', registration_required: 'דורש הרשמה', advance_booking: 'דורש הזמנה מראש', available_now: 'יש מקום פנוי' };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function selectHtml(id, valueOptions, labels, currentValue, includeEmpty) {
    const opts = (includeEmpty ? ['<option value="">לא צוין</option>'] : [])
      .concat(valueOptions.map((v) => '<option value="' + escapeHtml(v) + '"' + (v === currentValue ? ' selected' : '') + '>' + escapeHtml((labels && labels[v]) || v) + '</option>'));
    return '<select id="' + id + '">' + opts.join('') + '</select>';
  }

  function tagGroupHtml(id, valueOptions, currentValues) {
    const current = new Set(currentValues || []);
    return '<div class="tag-group" id="' + id + '">' +
      valueOptions.map((v) => '<label class="tag-check"><input type="checkbox" value="' + escapeHtml(v) + '"' + (current.has(v) ? ' checked' : '') + '>' + escapeHtml(v) + '</label>').join('') +
      '</div>';
  }

  function readTagGroup(id) {
    return Array.from(document.getElementById(id).querySelectorAll('input:checked')).map((el) => el.value);
  }

  function activityMatchesFilters(a) {
    const q = $search.value.trim().toLowerCase();
    if (q && !(a.name || '').toLowerCase().includes(q)) return false;
    if ($statusFilter.value && a.status !== $statusFilter.value) return false;
    if ($categoryFilter.value && a.category !== $categoryFilter.value) return false;
    if (activeQuickFilter === 'issues' && computeIssues(a).length === 0) return false;
    if (activeQuickFilter === 'stale' && !isStale(a)) return false;
    if (activeQuickFilter === 'no_photo' && !computeIssues(a).some((i) => i.code === 'no_photo')) return false;
    return true;
  }

  function activityHasApprovedPhoto(a) {
    return (a.activity_images || []).some((img) => img.status === 'approved');
  }

  function renderRowView(a) {
    const cityLabel = a.location ? [a.location.name, a.location.city].filter(Boolean).join(' · ') : 'ללא מיקום';
    const sourceLink = a.source_url ? '<a class="source-link" href="' + escapeHtml(a.source_url) + '" target="_blank" rel="noopener noreferrer">🔗 מקור</a>' : '';
    const officialLink = a.official_url ? '<a class="source-link" href="' + escapeHtml(a.official_url) + '" target="_blank" rel="noopener noreferrer">🌐 אתר רשמי</a>' : '';
    const photoSkippedStar = (a.photo_skipped && !activityHasApprovedPhoto(a))
      ? '<span class="photo-skipped-star" title="אושר ללא תמונה">⭐</span>'
      : '';
    const issues = computeIssues(a);
    const issuesHtml = issues.map((i) => '<span class="issue-badge">' + escapeHtml(i.label) + '</span>').join('');
    const staleHtml = isStale(a) ? '<span class="stale-badge">דורשת עדכון</span>' : '';
    const verifiedText = a.last_verified_at ? 'עודכן לאחרונה: ' + formatDate(a.last_verified_at) : '';
    return '<div class="row-head">' +
      '<input type="checkbox" class="row-select" data-id="' + a.id + '"' + (selectedIds.has(a.id) ? ' checked' : '') + '>' +
      '<span class="status-badge ' + a.status + '">' + (statusLabels[a.status] || a.status) + '</span>' +
      (a.category ? '<span class="cat-badge">' + escapeHtml(a.category) + '</span>' : '') +
      '<span class="row-title">' + escapeHtml(a.name) + photoSkippedStar + '</span>' +
      '<span class="row-meta">' + escapeHtml(cityLabel) + '</span>' +
      sourceLink +
      officialLink +
      '<span class="row-actions">' +
        (a.status === 'pending' ? '<button class="icon-btn approve-btn" data-id="' + a.id + '">אשר</button>' : '') +
        '<button class="icon-btn edit-btn" data-id="' + a.id + '">ערוך</button>' +
        '<button class="icon-btn danger delete-btn" data-id="' + a.id + '">מחק</button>' +
      '</span>' +
    '</div>' +
    ((issuesHtml || staleHtml || verifiedText) ? (
      '<div class="row-head" style="padding-top:0;">' +
        issuesHtml + staleHtml +
        '<span class="verified-meta">' + verifiedText + '</span>' +
        '<button class="verify-row-btn" data-id="' + a.id + '">✓ אמת</button>' +
      '</div>'
    ) : '');
  }

  function scheduleSummary(a) {
    const s = a.activity_schedules || [];
    if (s.length === 0) return 'אין מידע על לוח זמנים (לא ניתן לערוך כרגע דרך המסך הזה)';
    return s.map((row) => {
      if (row.schedule_type === 'recurring') return 'כל יום ' + (row.day_of_week || '') + (row.start_time ? ' ' + row.start_time.slice(0,5) + '-' + (row.end_time ? row.end_time.slice(0,5) : '') : '');
      if (row.schedule_type === 'one_time') return (row.one_time_date || '') + (row.start_time ? ' ' + row.start_time.slice(0,5) : '');
      if (row.schedule_type === 'fixed_hours') return 'שעות פתיחה: ' + (row.start_time ? row.start_time.slice(0,5) : '?') + '-' + (row.end_time ? row.end_time.slice(0,5) : '?');
      return row.schedule_type;
    }).join(' · ');
  }

  function renderEditPhotos(a) {
    const images = a.activity_images || [];
    if (images.length === 0) {
      return '<div class="field-block"><label>תמונות</label><div class="row-meta">אין תמונות עדיין</div></div>';
    }
    return '<div class="field-block"><label>תמונות (' + images.length + ')</label>' +
      '<div class="edit-photo-row">' +
      images.map((img) => (
        '<div class="edit-photo-item">' +
          '<a href="' + escapeHtml(img.url) + '" target="_blank" rel="noopener noreferrer">' +
            '<img class="edit-photo-thumb" src="' + escapeHtml(img.url) + '" loading="lazy">' +
          '</a>' +
          '<button class="edit-photo-delete" data-photo-id="' + img.id + '" data-activity-id="' + a.id + '" title="מחק תמונה">✕</button>' +
        '</div>'
      )).join('') +
      '</div></div>';
  }

  // 🎟️ הטבות והנחות - טבלת-בת עם כמה שורות אפשריות לכל פעילות (activity_benefits, supabase/0038).
  // בניגוד לשדות selectHtml/tagGroupHtml הקיימים (שדה בודד ב-activities עצמה, ID גלובלי כי יש
  // רק עותק אחד בעמוד) - כאן יכולות להיות כמה שורות/טפסים בו-זמנית, אז השדות מסומנים ב-
  // data-field ונקראים יחסית ל-container (form.querySelectorAll), לא לפי id גלובלי.
  function selectFieldHtml(field, valueOptions, labels, currentValue, includeEmpty) {
    const opts = (includeEmpty ? ['<option value="">לא צוין</option>'] : [])
      .concat((valueOptions || []).map((v) => '<option value="' + escapeHtml(v) + '"' + (v === currentValue ? ' selected' : '') + '>' + escapeHtml((labels && labels[v]) || v) + '</option>'));
    return '<select data-field="' + field + '">' + opts.join('') + '</select>';
  }

  function formatBenefitValue(b) {
    if (b.value) return b.value;
    if (b.benefit_type === 'one_plus_one') return '1+1';
    if (b.benefit_type === 'special_price' && b.special_price != null) return 'מחיר מיוחד: ' + b.special_price + ' ₪';
    return (options.benefitTypeLabels && options.benefitTypeLabels[b.benefit_type]) || b.benefit_type;
  }

  function benefitStatusDot(status) {
    return status === 'expired' ? '🔴' : status === 'needs_review' ? '🟡' : '🟢';
  }

  function benefitFieldsHtml(b) {
    b = b || {};
    return (
      '<div class="field-grid">' +
        '<div class="field-block"><label>נותן ההטבה</label>' + selectFieldHtml('provider', options.benefitProvider, null, b.provider, true) + '</div>' +
        '<div class="field-block"><label>סוג ההטבה</label>' + selectFieldHtml('benefit_type', options.benefitType, options.benefitTypeLabels, b.benefit_type, true) + '</div>' +
        '<div class="field-block"><label>ערך ההטבה (למשל 20%)</label><input data-field="value" type="text" value="' + escapeHtml(b.value || '') + '"></div>' +
        '<div class="field-block"><label>מחיר מיוחד (₪)</label><input data-field="special_price" type="number" value="' + (b.special_price ?? '') + '"></div>' +
        '<div class="field-block"><label>תאריך התחלה</label><input data-field="valid_from" type="date" value="' + (b.valid_from || '') + '"></div>' +
        '<div class="field-block"><label>תאריך סיום</label><input data-field="valid_until" type="date" value="' + (b.valid_until || '') + '"></div>' +
        '<div class="field-block"><label>איך מממשים</label>' + selectFieldHtml('redemption_method', options.redemptionMethod, options.redemptionMethodLabels, b.redemption_method, true) + '</div>' +
        '<div class="field-block"><label>סטטוס</label>' + selectFieldHtml('status', options.benefitStatus, options.benefitStatusLabels, b.status || 'active', false) + '</div>' +
      '</div>' +
      '<div class="field-grid">' +
        '<div class="field-block"><label>קישור למימוש</label><input data-field="redemption_url" type="text" value="' + escapeHtml(b.redemption_url || '') + '"></div>' +
        '<div class="field-block"><label>קוד קופון</label><input data-field="coupon_code" type="text" value="' + escapeHtml(b.coupon_code || '') + '"></div>' +
      '</div>' +
      '<div class="field-grid wide">' +
        '<div class="field-block"><label>תנאי ההטבה</label><textarea data-field="terms">' + escapeHtml(b.terms || '') + '</textarea></div>' +
      '</div>'
    );
  }

  function renderBenefitRow(a, b) {
    return '<div class="benefit-row" data-benefit-row="' + b.id + '">' +
      '<span>' + benefitStatusDot(b.status) + '</span>' +
      '<span class="benefit-row-text"><strong>' + escapeHtml(b.provider) + '</strong> · ' + escapeHtml(formatBenefitValue(b)) +
        (b.valid_until ? ' · עד ' + escapeHtml(b.valid_until) : '') +
        ' · נבדק לאחרונה: ' + escapeHtml(formatDate(b.last_verified_at)) +
      '</span>' +
      '<span class="row-actions">' +
        '<button class="icon-btn benefit-edit-btn" data-benefit-id="' + b.id + '" data-activity-id="' + a.id + '">ערוך</button>' +
        '<button class="icon-btn danger benefit-delete-btn" data-benefit-id="' + b.id + '" data-activity-id="' + a.id + '">מחק</button>' +
      '</span>' +
    '</div>';
  }

  function renderEditBenefits(a) {
    const benefits = a.activity_benefits || [];
    return '<div class="field-block benefits-block" data-benefits-for="' + a.id + '">' +
      '<label>🎟️ הטבות והנחות (' + benefits.length + ')</label>' +
      '<div class="benefit-rows">' + benefits.map((b) => renderBenefitRow(a, b)).join('') + '</div>' +
      '<button class="icon-btn benefit-add-toggle" data-activity-id="' + a.id + '">+ הוספת הטבה</button>' +
    '</div>';
  }

  function renderEditForm(a) {
    return '<div class="edit-form" data-edit-for="' + a.id + '">' +
      '<div class="field-grid">' +
        '<div class="field-block"><label>שם</label><input id="f_name" type="text" value="' + escapeHtml(a.name) + '"></div>' +
        '<div class="field-block"><label>סטטוס</label>' + selectHtml('f_status', options.status, statusLabels, a.status, false) + '</div>' +
        '<div class="field-block"><label>סוג</label>' + selectHtml('f_entity_type', options.entityType, entityTypeLabels, a.entity_type, false) + '</div>' +
        '<div class="field-block"><label>קטגוריה</label>' + selectHtml('f_category', options.category, null, a.category, true) + '</div>' +
        '<div class="field-block"><label>גיל מ-</label><input id="f_min_age" type="number" step="0.5" value="' + (a.min_age ?? '') + '"></div>' +
        '<div class="field-block"><label>גיל עד</label><input id="f_max_age" type="number" step="0.5" value="' + (a.max_age ?? '') + '"></div>' +
        '<div class="field-block"><label>סוג מחיר</label>' + selectHtml('f_price_type', options.priceType, priceTypeLabels, a.price_type, true) + '</div>' +
        '<div class="field-block"><label>סכום (ש"ח)</label><input id="f_price_amount" type="number" value="' + (a.price_amount ?? '') + '"></div>' +
        '<div class="field-block"><label>משך (דקות)</label><input id="f_duration_minutes" type="number" value="' + (a.duration_minutes ?? '') + '"></div>' +
        '<div class="field-block"><label>מקום</label>' + selectHtml('f_indoor_outdoor', options.indoorOutdoor, indoorOutdoorLabels, a.indoor_outdoor, true) + '</div>' +
        '<div class="field-block"><label>הזמנה מראש</label>' + selectHtml('f_booking_requirement', options.booking, bookingLabels, a.booking_requirement, true) + '</div>' +
      '</div>' +
      '<div class="field-grid wide">' +
        '<div class="field-block"><label>תיאור</label><textarea id="f_description">' + escapeHtml(a.description || '') + '</textarea></div>' +
      '</div>' +
      '<div class="field-block"><label>מזג אוויר מתאים</label>' + tagGroupHtml('f_weather', options.weather, a.weather_suitable) + '</div>' +
      '<div class="field-block"><label>מתקנים</label>' + tagGroupHtml('f_amenities', options.amenities, a.amenities) + '</div>' +
      '<div class="field-block"><label>התאמה למשפחה</label>' + tagGroupHtml('f_family_fit', options.familyFit, a.family_fit) + '</div>' +
      renderEditPhotos(a) +
      renderEditBenefits(a) +
      '<div class="field-grid">' +
        '<div class="field-block"><label>שם המקום</label><input id="f_loc_name" type="text" value="' + escapeHtml(a.location?.name || '') + '"></div>' +
        '<div class="field-block"><label>פרטי מיקום (קומה/אזור)</label><input id="f_location_detail" type="text" value="' + escapeHtml(a.location_detail || '') + '"></div>' +
        '<div class="field-block"><label>עיר/יישוב</label><input id="f_loc_city" type="text" value="' + escapeHtml(a.location?.city || '') + '"></div>' +
        '<div class="field-block"><label>אזור בארץ</label>' + selectHtml('f_loc_region', options.region, null, a.location?.region, true) + '</div>' +
        '<div class="field-block"><label>כתובת</label><input id="f_loc_address" type="text" value="' + escapeHtml(a.location?.address || '') + '"></div>' +
      '</div>' +
      '<div class="geo-row">' +
        '<span class="geo-status" data-geo-status-for="' + a.id + '">' +
          (a.location && a.location.lat != null && a.location.lng != null
            ? '📍 יש קואורדינטות למפה'
            : '⚠️ אין קואורדינטות - הפעילות לא תופיע על המפה') +
        '</span>' +
        (a.location?.id ? '<button class="geocode-btn" data-location-id="' + a.location.id + '" data-activity-id="' + a.id + '">🌍 אתר קואורדינטות מחדש</button>' : '') +
      '</div>' +
      '<div class="row-meta">לוח זמנים: ' + escapeHtml(scheduleSummary(a)) + '</div>' +
      '<div class="form-actions">' +
        '<button class="save-btn" data-id="' + a.id + '">שמור שינויים</button>' +
        '<button class="cancel-btn" data-id="' + a.id + '">בטל</button>' +
        '<span class="edit-status" data-edit-status-for="' + a.id + '"></span>' +
      '</div>' +
    '</div>';
  }

  function groupByRegion(activities) {
    const groups = new Map();
    options.region.forEach((r) => groups.set(r, []));
    groups.set('ללא אזור', []);
    activities.forEach((a) => {
      const region = a.location && a.location.region ? a.location.region : 'ללא אזור';
      if (!groups.has(region)) groups.set(region, []);
      groups.get(region).push(a);
    });
    return groups;
  }

  function renderAll() {
    const filtered = allActivities.filter(activityMatchesFilters);
    $status.textContent = 'מציג ' + filtered.length + ' מתוך ' + allActivities.length + ' פעילויות.';
    $status.className = 'status';
    const groups = groupByRegion(filtered);
    const sections = [];
    groups.forEach((rows, region) => {
      if (rows.length === 0) return;
      const collapsed = collapsedRegions.has(region);
      sections.push(
        '<div class="region-section">' +
          '<div class="region-header" data-region="' + escapeHtml(region) + '">' +
            '<span class="region-title">' + escapeHtml(region) + '</span>' +
            '<span class="region-count">' + rows.length + ' פעילויות ' + (collapsed ? '▸' : '▾') + '</span>' +
          '</div>' +
          '<div class="region-body' + (collapsed ? ' collapsed' : '') + '">' +
            rows.map((a) => '<div class="row" data-row-id="' + a.id + '">' + renderRowView(a) + '</div>').join('') +
          '</div>' +
        '</div>'
      );
    });
    $regions.innerHTML = sections.join('') || '<div class="status">אין פעילויות תואמות.</div>';
    updateBulkSelectBar();
    renderMissingPhotos();
    renderStatusList();
    renderIssues();
    renderBrokenLinks();
  }

  // --- "דורש טיפול" (במקור עמוד "איכות נתונים" נפרד) ---

  function issueRowHtml(code, activity) {
    const subtitle = activity.location ? (activity.location.city || activity.location.name || '') : '';
    return '<div class="issue-row" data-issue-row data-id="' + activity.id + '">' +
      '<span class="issue-row-left">' +
        '<input type="checkbox" class="issue-select-box issue-row-select" data-code="' + code + '" data-id="' + activity.id + '"' + (issueSelectedIds.get(code).has(activity.id) ? ' checked' : '') + '>' +
        '<span>' + escapeHtml(activity.name) + (subtitle ? ' · ' + escapeHtml(subtitle) : '') + '</span>' +
      '</span>' +
      '<span class="issue-row-actions">' +
        '<button class="issue-row-dismiss" data-dismiss data-code="' + code + '" data-id="' + activity.id + '">🙈 התעלם</button>' +
        '<a class="issue-row-edit" href="/activities?edit=' + activity.id + '">ערוך</a>' +
      '</span>' +
    '</div>';
  }

  function issueGroupHeadHtml(code, items) {
    const selected = issueSelectedIds.get(code);
    Array.from(selected).forEach((id) => { if (!items.some((it) => it.activity.id === id)) selected.delete(id); });
    const selCount = selected.size;
    const searchBtn = SEARCHABLE_ISSUE_CODES.has(code)
      ? '<button class="mini-btn primary issue-search-btn" data-code="' + code + '"' + (selCount === 0 ? ' disabled' : '') + '>🔍 חפש מידע חסר' + (selCount ? ' (' + selCount + ')' : '') + '</button>'
      : '';
    return '<div class="issue-group-head">' +
      '<div class="issue-group-title">' + escapeHtml(items[0].label) + ' (' + items.length + ')</div>' +
      '<div class="issue-group-actions">' +
        '<label class="issue-select-all-wrap"><input type="checkbox" class="issue-select-box issue-select-all" data-code="' + code + '"' + (selCount > 0 && selCount === items.length ? ' checked' : '') + '> בחר הכל</label>' +
        searchBtn +
        '<button class="mini-btn danger issue-dismiss-selected-btn" data-code="' + code + '"' + (selCount === 0 ? ' disabled' : '') + '>🙈 התעלם מהנבחרים' + (selCount ? ' (' + selCount + ')' : '') + '</button>' +
      '</div>' +
    '</div>';
  }

  function renderIssues() {
    activityById = new Map(allActivities.map((a) => [a.id, a]));
    const byCode = new Map(ISSUE_ORDER.map((c) => [c, []]));
    let totalWithIssues = 0;
    for (const a of allActivities) {
      const issues = computeIssues(a);
      if (issues.length > 0) totalWithIssues++;
      for (const issue of issues) {
        if (!byCode.has(issue.code)) byCode.set(issue.code, []);
        byCode.get(issue.code).push({ activity: a, label: issue.label });
      }
    }
    $tabAttentionCount.textContent = totalWithIssues ? ' (' + totalWithIssues + ')' : '';
    ISSUE_ORDER.forEach((code) => dismissedIssueIds.set(code, new Set()));
    for (const a of allActivities) {
      (a.dismissed_issues || []).forEach((d) => {
        if (dismissedIssueIds.has(d.issue_code)) dismissedIssueIds.get(d.issue_code).add(a.id);
      });
    }
    const groupsHtml = ISSUE_ORDER
      .map((code) => ({ code, items: byCode.get(code) || [] }))
      .filter((g) => g.items.length > 0)
      .map((g) => (
        '<div class="issue-group" data-issue-group="' + g.code + '">' +
          issueGroupHeadHtml(g.code, g.items) +
          g.items.map(({ activity }) => issueRowHtml(g.code, activity)).join('') +
        '</div>'
      )).join('');
    $issuesList.innerHTML = groupsHtml || '<div class="empty-note">אין כרגע פעילויות עם מידע חסר. 🎉</div>';
  }

  function renderBrokenLinks() {
    const dismissed = dismissedIssueIds.get('broken_link') || new Set();
    const broken = allActivities.filter((a) => a.link_broken === true && !dismissed.has(a.id));
    if (broken.length === 0) {
      $brokenLinksList.innerHTML = '<div class="empty-note">אין כרגע קישורים שידוע שהם שבורים. (לחצו "בדוק קישורים שבורים" כדי לבדוק).</div>';
      return;
    }
    $brokenLinksList.innerHTML = broken.map((a) => (
      '<div class="issue-row" data-issue-row data-id="' + a.id + '">' +
        '<span class="issue-row-left"><span>' + escapeHtml(a.name) + ' · <a href="' + escapeHtml(a.official_url || a.source_url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(a.official_url || a.source_url) + '</a></span></span>' +
        '<span class="issue-row-actions">' +
          '<button class="issue-row-dismiss" data-dismiss data-code="broken_link" data-id="' + a.id + '">🙈 התעלם</button>' +
          '<a class="issue-row-edit" href="/activities?edit=' + a.id + '">ערוך</a>' +
        '</span>' +
      '</div>'
    )).join('');
  }

  async function dismissIssue(code, ids) {
    const res = await fetch('/api/manage/dismiss-issue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, issueCode: code }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
  }

  async function fillMissingInfo(id, code) {
    const res = await fetch('/api/manage/fill-missing-info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, issueCode: code }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
    if (data.found && data.activity) {
      const idx = allActivities.findIndex((a) => a.id === id);
      if (idx !== -1) allActivities[idx] = data.activity;
    }
    return data.found;
  }

  async function handleAttentionListClick(e) {
    const selectAllBox = e.target.closest('.issue-select-all');
    if (selectAllBox) {
      const code = selectAllBox.dataset.code;
      const group = selectAllBox.closest('.issue-group');
      const boxes = Array.from(group.querySelectorAll('.issue-row-select'));
      const set = issueSelectedIds.get(code);
      if (selectAllBox.checked) boxes.forEach((b) => set.add(b.dataset.id));
      else set.clear();
      renderIssues();
      return;
    }

    const rowSelect = e.target.closest('.issue-row-select');
    if (rowSelect) {
      const code = rowSelect.dataset.code;
      const id = rowSelect.dataset.id;
      const set = issueSelectedIds.get(code);
      if (rowSelect.checked) set.add(id); else set.delete(id);
      renderIssues();
      return;
    }

    const dismissBtn = e.target.closest('[data-dismiss]');
    if (dismissBtn) {
      const code = dismissBtn.dataset.code;
      const id = dismissBtn.dataset.id;
      dismissBtn.disabled = true;
      dismissBtn.textContent = '...';
      try {
        await dismissIssue(code, [id]);
        await load();
      } catch (err) {
        alert('שגיאה: ' + err.message);
        dismissBtn.disabled = false;
        dismissBtn.textContent = '🙈 התעלם';
      }
      return;
    }

    const dismissSelectedBtn = e.target.closest('.issue-dismiss-selected-btn');
    if (dismissSelectedBtn) {
      const code = dismissSelectedBtn.dataset.code;
      const ids = Array.from(issueSelectedIds.get(code));
      if (ids.length === 0) return;
      dismissSelectedBtn.disabled = true;
      dismissSelectedBtn.textContent = '...';
      try {
        await dismissIssue(code, ids);
        issueSelectedIds.get(code).clear();
        await load();
      } catch (err) {
        alert('שגיאה: ' + err.message);
        renderIssues();
      }
      return;
    }

    const searchBtn = e.target.closest('.issue-search-btn');
    if (searchBtn) {
      const code = searchBtn.dataset.code;
      const ids = Array.from(issueSelectedIds.get(code));
      if (ids.length === 0) return;
      searchBtn.disabled = true;
      let foundCount = 0;
      for (const id of ids) {
        searchBtn.textContent = 'מחפש... (' + (foundCount + 1) + '/' + ids.length + ')';
        try {
          const found = await fillMissingInfo(id, code);
          if (found) { foundCount++; issueSelectedIds.get(code).delete(id); }
        } catch { /* ממשיכים לפעילות הבאה */ }
      }
      renderIssues();
      renderBrokenLinks();
      if (foundCount < ids.length) {
        alert('נמצא ותוקן מידע עבור ' + foundCount + ' מתוך ' + ids.length + '. עבור השאר אפשר לערוך ידנית או "להתעלם".');
      }
      return;
    }

    // קליק על השורה עצמה (לא על checkbox/כפתור/קישור) - פותח לעריכה, כמו בשאר עמודי הניהול.
    const row = e.target.closest('[data-issue-row]');
    if (row && !e.target.closest('input, button, a')) {
      window.location.href = '/activities?edit=' + row.dataset.id;
    }
  }

  $issuesList.addEventListener('click', handleAttentionListClick);
  $brokenLinksList.addEventListener('click', handleAttentionListClick);

  function matchTypeLabel(g) {
    if (g.matchType === 'proximity') return 'קרבה גיאוגרפית (' + g.distanceMeters + ' מטר) + דמיון שם (' + Math.round(g.nameScore * 100) + '%)';
    return 'התאמה מדויקת (שם ומיקום זהים)';
  }

  function renderDupGroup(g, idx) {
    const [keeper, ...rest] = g.activities;
    const keeperFull = activityById.get(keeper.id);
    const rows = [
      '<div class="dup-item">' +
        '<span>' + escapeHtml(keeperFull ? keeperFull.name : keeper.id) + '<span class="dup-item-keeper-badge">ישמר</span></span>' +
      '</div>',
    ];
    rest.forEach((cand, i) => {
      const candFull = activityById.get(cand.id);
      rows.push(
        '<div class="dup-item" data-cand-row="' + idx + '-' + i + '">' +
          '<span>' + escapeHtml(candFull ? candFull.name : cand.id) + '</span>' +
          '<div class="dup-item-actions">' +
            '<button class="mini-btn primary merge-btn" data-keeper="' + keeper.id + '" data-cand="' + cand.id + '" data-target="' + idx + '-' + i + '">🔗 מזג לתוך הראשונה</button>' +
            '<button class="mini-btn danger dismiss-btn" data-a="' + keeper.id + '" data-b="' + cand.id + '">✖ השאר נפרדות</button>' +
          '</div>' +
        '</div>' +
        '<div class="merge-preview-slot" id="mergePreview-' + idx + '-' + i + '"></div>'
      );
    });
    return '<div class="dup-group">' +
      '<div class="dup-group-title">' + escapeHtml(keeperFull ? keeperFull.name : g.name) + '</div>' +
      '<div class="dup-group-meta">' + matchTypeLabel(g) + (g.locationName ? ' · ' + escapeHtml(g.locationName) : '') + '</div>' +
      rows.join('') +
    '</div>';
  }

  async function loadDuplicates() {
    const res = await fetch('/api/duplicates');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
    if (!data.groups || data.groups.length === 0) {
      $dupList.innerHTML = '<div class="empty-note">לא נמצאו כפילויות אפשריות. 🎉</div>';
      return;
    }
    $dupList.innerHTML = data.groups.map(renderDupGroup).join('');
  }

  $dupList.addEventListener('click', async (e) => {
    const mergeBtn = e.target.closest('.merge-btn');
    if (mergeBtn) {
      const keeperId = mergeBtn.dataset.keeper;
      const candId = mergeBtn.dataset.cand;
      const slot = document.getElementById('mergePreview-' + mergeBtn.dataset.target);
      mergeBtn.disabled = true;
      mergeBtn.textContent = 'בודק...';
      try {
        const candidate = activityById.get(candId);
        const res = await fetch('/api/suggest-merge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ existingActivityId: keeperId, candidate }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
        slot.innerHTML = '<div class="merge-preview">' +
          '<div><b>הצעת מיזוג:</b> ' + escapeHtml(data.reasoning || '') + '</div>' +
          '<div style="margin-top:6px;"><button class="mini-btn primary confirm-merge-btn" data-keeper="' + keeperId + '" data-cand="' + candId + '">אשר מיזוג ומחק כפולה</button> ' +
          '<button class="mini-btn cancel-merge-btn">ביטול</button></div>' +
          '<input type="hidden" class="merge-payload" value="' + escapeHtml(JSON.stringify({ mergedFields: data.mergedFields || {}, imageUrlsToAdd: data.image_urls_to_add || [] })) + '">' +
        '</div>';
        mergeBtn.disabled = false;
        mergeBtn.textContent = '🔗 מזג לתוך הראשונה';
      } catch (err) {
        slot.innerHTML = '<div class="merge-preview">שגיאה: ' + escapeHtml(err.message) + '</div>';
        mergeBtn.disabled = false;
        mergeBtn.textContent = '🔗 מזג לתוך הראשונה';
      }
      return;
    }

    const confirmBtn = e.target.closest('.confirm-merge-btn');
    if (confirmBtn) {
      const preview = confirmBtn.closest('.merge-preview');
      const payload = JSON.parse(preview.querySelector('.merge-payload').value);
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'ממזג...';
      try {
        const res = await fetch('/api/merge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            existingActivityId: confirmBtn.dataset.keeper,
            deleteActivityId: confirmBtn.dataset.cand,
            mergedFields: payload.mergedFields,
            imageUrlsToAdd: payload.imageUrlsToAdd,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
        await load();
      } catch (err) {
        preview.innerHTML = 'שגיאה במיזוג: ' + escapeHtml(err.message);
      }
      return;
    }

    const cancelBtn = e.target.closest('.cancel-merge-btn');
    if (cancelBtn) {
      cancelBtn.closest('.merge-preview').remove();
      return;
    }

    const dismissBtn = e.target.closest('.dismiss-btn');
    if (dismissBtn) {
      dismissBtn.disabled = true;
      try {
        const res = await fetch('/api/manage/dismiss-duplicate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idA: dismissBtn.dataset.a, idB: dismissBtn.dataset.b }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
        await loadDuplicates();
      } catch (err) {
        alert('שגיאה: ' + err.message);
        dismissBtn.disabled = false;
      }
    }
  });

  async function checkLinks() {
    $checkLinks.disabled = true;
    $checkLinks.textContent = 'בודק...';
    $attentionToolsStatus.textContent = 'בודק קישורים שעדיין לא נבדקו או שנבדקו לפני יותר משבוע (עד 60 בכל הרצה)...';
    try {
      const res = await fetch('/api/manage/check-links', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      $attentionToolsStatus.textContent = 'נבדקו ' + data.checked + ' קישורים, ' + data.broken + ' נמצאו שבורים.' +
        (data.remaining > 0 ? ' נשארו עוד ' + data.remaining + ' לבדיקה - לחצו שוב.' : '');
      await load();
    } catch (err) {
      $attentionToolsStatus.textContent = 'שגיאה: ' + err.message;
    } finally {
      $checkLinks.disabled = false;
      $checkLinks.textContent = '🔗 בדוק קישורים שבורים';
    }
  }

  async function geocodeMissing() {
    $geocodeMissing.disabled = true;
    $geocodeMissing.textContent = 'מאתר...';
    $attentionToolsStatus.textContent = 'זה יכול לקחת כמה דקות (בקשה אחת בשנייה) - אל תסגרו את הדף...';
    try {
      const res = await fetch('/api/manage/geocode-missing', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      $attentionToolsStatus.textContent = data.total === 0
        ? 'לכל המיקומים כבר יש קואורדינטות. 🎉'
        : 'נמצאו קואורדינטות ל-' + data.geocoded + ' מתוך ' + data.total + ' מיקומים' + (data.failed ? ' (' + data.failed + ' לא נמצאו).' : '.');
      await load();
    } catch (err) {
      $attentionToolsStatus.textContent = 'שגיאה: ' + err.message;
    } finally {
      $geocodeMissing.disabled = false;
      $geocodeMissing.textContent = '🌍 השלם קואורדינטות חסרות למפה';
    }
  }

  $checkLinks.addEventListener('click', checkLinks);
  $geocodeMissing.addEventListener('click', geocodeMissing);

  // פעילויות שאין להן אף תמונה מאושרת - זו בדיוק ההגדרה של "אין תמונה" מנקודת המבט של
  // המשתמשים באפליקציה (תמונה pending/rejected לא מוצגת להם, ראו RLS על activity_images).
  // רק approved/pending רלוונטיות כאן - archived/rejected ממילא לא מוצגות באפליקציה.
  function computeMissingPhotoActivities() {
    return allActivities.filter((a) => (
      (a.status === 'approved' || a.status === 'pending') &&
      !a.photo_skipped &&
      !activityHasApprovedPhoto(a)
    ));
  }

  function renderMissingPhotoRowView(a) {
    const locationLabel = a.location ? [a.location.name, a.location.city].filter(Boolean).join(' · ') : 'ללא מיקום';
    const subtitle = [a.category, locationLabel].filter(Boolean).join(' · ');
    const pendingImage = (a.activity_images || []).find((img) => img.status === 'pending');
    const actionsHtml = pendingImage
      ? '<span class="row-actions">' +
          '<button class="icon-btn photo-candidate-approve" data-photo-id="' + pendingImage.id + '" data-activity-id="' + a.id + '">אשר תמונה</button>' +
          '<button class="icon-btn danger photo-candidate-reject" data-photo-id="' + pendingImage.id + '" data-activity-id="' + a.id + '">דחה</button>' +
        '</span>'
      : '<span class="row-actions">' +
          '<button class="icon-btn search-photo-btn" data-id="' + a.id + '">חפש תמונה</button>' +
          '<button class="icon-btn manual-photo-btn" data-id="' + a.id + '">הוסף תמונה ידנית</button>' +
          '<button class="icon-btn approve-no-photo-btn" data-id="' + a.id + '">אשר ללא תמונה</button>' +
        '</span>';
    const candidatePreview = pendingImage
      ? '<div class="photo-candidate">' +
          '<img class="photo-candidate-thumb" src="' + escapeHtml(pendingImage.url) + '" loading="lazy">' +
          '<span class="photo-candidate-label">תמונה נמצאה - יש לאשר או לדחות לפני שהיא תוצג באפליקציה</span>' +
        '</div>'
      : '';
    return '<div class="row-head">' +
      '<input type="checkbox" class="row-select missing-photo-select" data-id="' + a.id + '"' + (missingPhotoSelectedIds.has(a.id) ? ' checked' : '') + '>' +
      '<span class="status-badge ' + a.status + '">' + (statusLabels[a.status] || a.status) + '</span>' +
      '<span class="row-title">' + escapeHtml(a.name) + '</span>' +
      '<span class="row-meta">' + escapeHtml(subtitle) + '</span>' +
      actionsHtml +
    '</div>' + candidatePreview;
  }

  function renderMissingPhotos() {
    const missing = computeMissingPhotoActivities();
    const validIds = new Set(missing.map((a) => a.id));
    Array.from(missingPhotoSelectedIds).forEach((id) => { if (!validIds.has(id)) missingPhotoSelectedIds.delete(id); });
    $tabMissingPhotosCount.textContent = missing.length ? ' (' + missing.length + ')' : '';
    $missingPhotosSummary.textContent = missing.length === 0
      ? 'כל הכבוד - לכל הפעילויות יש תמונה. 🎉'
      : 'נמצאו ' + missing.length + ' פעילויות ללא תמונה.';
    $missingPhotosList.innerHTML = missing.map((a) => '<div class="row" data-row-id="' + a.id + '">' + renderMissingPhotoRowView(a) + '</div>').join('');
    updateMissingPhotosBulkBar();
  }

  function updateMissingPhotosBulkBar() {
    const count = missingPhotoSelectedIds.size;
    $missingPhotosBulkBar.classList.toggle('visible', count > 0);
    $missingPhotosBulkCount.textContent = count + ' פעילויות מסומנות';
    $missingPhotosBulkSearchBtn.disabled = count === 0;
    $missingPhotosBulkSearchBtn.textContent = count > 0 ? 'חפש תמונה ל-' + count + ' פעילויות מסומנות' : 'חפש תמונה לכל הפעילויות המסומנות';
    const total = computeMissingPhotoActivities().length;
    $missingPhotosSelectAll.checked = total > 0 && count === total;
  }

  $missingPhotosSelectAll.addEventListener('change', () => {
    if ($missingPhotosSelectAll.checked) {
      computeMissingPhotoActivities().forEach((a) => missingPhotoSelectedIds.add(a.id));
    } else {
      missingPhotoSelectedIds.clear();
    }
    renderMissingPhotos();
  });

  function applyFoundImage(activityId, image) {
    const activity = allActivities.find((a) => a.id === activityId);
    if (activity) {
      activity.activity_images = [...(activity.activity_images || []), image];
    }
    missingPhotoSelectedIds.delete(activityId);
  }

  async function searchPhotoFor(id) {
    const res = await fetch('/api/manage/search-photo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
    if (data.found) applyFoundImage(id, data.image);
    return data.found;
  }

  $missingPhotosList.addEventListener('change', (e) => {
    const box = e.target.closest('.missing-photo-select');
    if (!box) return;
    const id = box.dataset.id;
    if (box.checked) missingPhotoSelectedIds.add(id); else missingPhotoSelectedIds.delete(id);
    updateMissingPhotosBulkBar();
  });

  $missingPhotosList.addEventListener('click', async (e) => {
    const searchBtn = e.target.closest('.search-photo-btn');
    if (searchBtn) {
      const id = searchBtn.dataset.id;
      searchBtn.disabled = true;
      searchBtn.textContent = 'מחפש...';
      try {
        const found = await searchPhotoFor(id);
        if (found) {
          renderMissingPhotos();
        } else {
          searchBtn.disabled = false;
          searchBtn.textContent = 'חפש תמונה';
          alert('לא נמצאה תמונה מתאימה. אפשר לנסות "הוסף תמונה ידנית".');
        }
      } catch (err) {
        searchBtn.disabled = false;
        searchBtn.textContent = 'חפש תמונה';
        alert('שגיאה בחיפוש תמונה: ' + err.message);
      }
      return;
    }

    const manualBtn = e.target.closest('.manual-photo-btn');
    if (manualBtn) {
      manualPhotoTargetId = manualBtn.dataset.id;
      $manualPhotoInput.click();
      return;
    }

    const approveNoPhotoBtn = e.target.closest('.approve-no-photo-btn');
    if (approveNoPhotoBtn) {
      const id = approveNoPhotoBtn.dataset.id;
      approveNoPhotoBtn.disabled = true;
      approveNoPhotoBtn.textContent = '...';
      try {
        const res = await fetch('/api/manage/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, fields: { status: 'approved', photo_skipped: true } }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
        const idx = allActivities.findIndex((a) => a.id === id);
        if (idx !== -1) allActivities[idx] = data.activity;
        missingPhotoSelectedIds.delete(id);
        renderMissingPhotos();
        renderAll();
      } catch (err) {
        approveNoPhotoBtn.disabled = false;
        approveNoPhotoBtn.textContent = 'אשר ללא תמונה';
        alert('שגיאה באישור: ' + err.message);
      }
      return;
    }

    const candidateApproveBtn = e.target.closest('.photo-candidate-approve');
    const candidateRejectBtn = e.target.closest('.photo-candidate-reject');
    if (candidateApproveBtn || candidateRejectBtn) {
      const btn = candidateApproveBtn || candidateRejectBtn;
      const photoId = btn.dataset.photoId;
      const activityId = btn.dataset.activityId;
      const status = candidateApproveBtn ? 'approved' : 'rejected';
      btn.disabled = true;
      btn.textContent = '...';
      try {
        const res = await fetch('/api/manage/photo-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: photoId, status }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
        const activity = allActivities.find((a) => a.id === activityId);
        const img = activity && (activity.activity_images || []).find((i) => i.id === photoId);
        if (img) img.status = status;
        renderAll();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = candidateApproveBtn ? 'אשר תמונה' : 'דחה';
        alert('שגיאה: ' + err.message);
      }
    }
  });

  $manualPhotoInput.addEventListener('change', async () => {
    const file = $manualPhotoInput.files && $manualPhotoInput.files[0];
    const id = manualPhotoTargetId;
    $manualPhotoInput.value = '';
    if (!file || !id) return;
    const btn = $missingPhotosList.querySelector('.manual-photo-btn[data-id="' + id + '"]');
    if (btn) { btn.disabled = true; btn.textContent = 'מעלה...'; }
    try {
      const imageDataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const res = await fetch('/api/manage/manual-photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, imageDataUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      applyFoundImage(id, data.image);
      renderMissingPhotos();
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'הוסף תמונה ידנית'; }
      alert('שגיאה בהעלאת התמונה: ' + err.message);
    }
  });

  $missingPhotosBulkSearchBtn.addEventListener('click', async () => {
    const ids = Array.from(missingPhotoSelectedIds);
    if (ids.length === 0) return;
    $missingPhotosBulkSearchBtn.disabled = true;
    $missingPhotosBulkSearchBtn.textContent = 'מחפש...';
    let notFoundCount = 0;
    for (const id of ids) {
      try {
        const found = await searchPhotoFor(id);
        if (!found) notFoundCount++;
      } catch (err) {
        notFoundCount++;
      }
    }
    renderMissingPhotos();
    if (notFoundCount > 0) {
      alert('לא נמצאה תמונה עבור ' + notFoundCount + ' מהפעילויות המסומנות. אפשר לנסות "הוסף תמונה ידנית" עבורן.');
    }
  });

  function updateBulkSelectBar() {
    const validIds = new Set(allActivities.map((a) => a.id));
    Array.from(selectedIds).forEach((id) => { if (!validIds.has(id)) selectedIds.delete(id); });
    const count = selectedIds.size;
    $bulkSelectBar.classList.toggle('visible', count > 0);
    $bulkSelectCount.textContent = count + ' פעילויות מסומנות';
    $bulkApproveBtn.disabled = count === 0;
    $bulkVerifyBtn.disabled = count === 0;
    $bulkDeleteBtn.disabled = count === 0;
  }

  let pendingPhotos = [];

  function renderPhotosList() {
    if (pendingPhotos.length === 0) {
      $photosSection.style.display = 'none';
      return;
    }
    $photosSection.style.display = 'block';
    document.querySelector('.photos-title').textContent = 'תמונות ממתינות לאישור (' + pendingPhotos.length + ')';
    $photosList.innerHTML = pendingPhotos.map((p) => (
      '<div class="photo-card" data-photo-id="' + p.id + '">' +
        '<img class="photo-thumb" src="' + escapeHtml(p.url) + '" loading="lazy">' +
        '<div class="photo-info">מתוך: <b>' + escapeHtml(p.activity ? p.activity.name : 'פעילות לא ידועה') + '</b></div>' +
        '<div class="photo-actions">' +
          '<button class="photo-approve-btn" data-id="' + p.id + '" data-status="approved">אשר</button>' +
          '<button class="photo-reject-btn" data-id="' + p.id + '" data-status="rejected">דחה</button>' +
        '</div>' +
      '</div>'
    )).join('');
  }

  async function loadPendingPhotos() {
    try {
      const res = await fetch('/api/manage/pending-photos');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      pendingPhotos = data.photos;
      renderPhotosList();
    } catch (err) {
      $photosSection.style.display = 'block';
      $photosList.innerHTML = '<div class="status error">שגיאה בטעינת תמונות: ' + escapeHtml(err.message) + '</div>';
    }
  }

  function formatDate(iso) {
    try { return new Date(iso).toLocaleString('he-IL'); } catch { return iso; }
  }

  let allReports = [];

  function renderReportsList() {
    // מוצג רק כשיש דיווח שממתין בפועל לטיפול - דיווחים שכבר טופלו לא נשארים תלויים למעלה
    // כבלגן קבוע (הם עדיין קיימים ב-DB, פשוט לא צריך שיתפסו מקום בראש העמוד).
    const pending = allReports.filter((r) => r.status === 'pending');
    if (pending.length === 0) {
      $reportsSection.style.display = 'none';
      return;
    }
    $reportsSection.style.display = 'block';
    document.querySelector('.reports-title').textContent = 'דיווחים על פעילויות (' + pending.length + ' ממתינים לטיפול)';
    $reportsList.innerHTML = pending.map((r) => (
      '<div class="report-card" data-report-id="' + r.id + '">' +
        '<div class="report-head">' +
          '<span class="status-badge ' + (r.status === 'pending' ? 'pending' : 'approved') + '">' + (r.status === 'pending' ? 'ממתין לטיפול' : 'טופל') + '</span>' +
          '<span class="report-activity-name">' + escapeHtml(r.activity ? r.activity.name : 'פעילות שנמחקה') + '</span>' +
          '<span class="report-date">' + formatDate(r.createdAt) + '</span>' +
          (r.status === 'pending' ? '<button class="report-resolve-btn" data-id="' + r.id + '">סמן כטופל</button>' : '') +
        '</div>' +
        (r.reason ? '<div class="report-reason">' + escapeHtml(r.reason) + '</div>' : '') +
      '</div>'
    )).join('');
  }

  async function loadReports() {
    try {
      const res = await fetch('/api/manage/reports');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      allReports = data.reports;
      renderReportsList();
    } catch (err) {
      $reportsSection.style.display = 'block';
      $reportsList.innerHTML = '<div class="status error">שגיאה בטעינת דיווחים: ' + escapeHtml(err.message) + '</div>';
    }
  }

  $reportsList.addEventListener('click', async (e) => {
    const btn = e.target.closest('.report-resolve-btn');
    if (!btn) return;
    const id = btn.dataset.id;
    btn.disabled = true;
    btn.textContent = '...';
    try {
      const res = await fetch('/api/manage/report-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status: 'resolved' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      const report = allReports.find((r) => r.id === id);
      if (report) report.status = 'resolved';
      renderReportsList();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'סמן כטופל';
      alert('שגיאה: ' + err.message);
    }
  });

  $photosList.addEventListener('click', async (e) => {
    const btn = e.target.closest('.photo-approve-btn') || e.target.closest('.photo-reject-btn');
    if (!btn) return;
    const id = btn.dataset.id;
    const status = btn.dataset.status;
    const card = $photosList.querySelector('.photo-card[data-photo-id="' + id + '"]');
    const buttons = card.querySelectorAll('button');
    buttons.forEach((b) => { b.disabled = true; });
    try {
      const res = await fetch('/api/manage/photo-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      const approvedPhoto = pendingPhotos.find((p) => p.id === id);
      pendingPhotos = pendingPhotos.filter((p) => p.id !== id);
      renderPhotosList();
      if (approvedPhoto && approvedPhoto.activity) {
        const activity = allActivities.find((a) => a.id === approvedPhoto.activity.id);
        const img = activity && (activity.activity_images || []).find((i) => i.id === id);
        if (img) img.status = status;
        renderMissingPhotos();
      }
    } catch (err) {
      buttons.forEach((b) => { b.disabled = false; });
      alert('שגיאה: ' + err.message);
    }
  });

  async function load() {
    try {
      const [optsRes, actsRes] = await Promise.all([fetch('/api/manage/options'), fetch('/api/manage/activities')]);
      options = await optsRes.json();
      const actsData = await actsRes.json();
      if (!actsRes.ok) throw new Error(actsData.error || 'שגיאה לא ידועה');
      allActivities = actsData.activities;
      $categoryFilter.innerHTML = '<option value="">כל הקטגוריות</option>' +
        options.category.map((c) => '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>').join('');
      $bulkCategorySelect.innerHTML = '<option value="">שנה קטגוריה ל...</option>' +
        options.category.map((c) => '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>').join('');
      $bulkRegionSelect.innerHTML = '<option value="">שנה אזור ל...</option>' +
        options.region.map((r) => '<option value="' + escapeHtml(r) + '">' + escapeHtml(r) + '</option>').join('');
      // כל האזורים סגורים כברירת מחדל - כדי לא להציף את המסך עם כל הפעילויות בטעינה הראשונה.
      collapsedRegions = new Set([...options.region, 'ללא אזור']);
      applyUrlParams();
      renderAll();
      loadPendingPhotos();
      loadReports();
      loadDuplicates().catch((err) => { $dupList.innerHTML = '<div class="empty-note">שגיאה בטעינת כפילויות: ' + escapeHtml(err.message) + '</div>'; });
    } catch (err) {
      $status.textContent = 'שגיאה בטעינה: ' + err.message;
      $status.className = 'status error';
    }
  }

  // תמיכה בקישורים עמוקים מהדשבורד/עמוד איכות הנתונים - ?filter=pending|issues|stale|no_photo
  // מגדיר את activeQuickFilter (נבדק ב-activityMatchesFilters), ?edit=<id> פותח את טופס העריכה
  // של אותה פעילות ומגלגל אליה אוטומטית.
  function applyUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const filter = params.get('filter');
    if (filter) {
      activeQuickFilter = filter;
      collapsedRegions = new Set();
      // ברירת המחדל של סינון הסטטוס היא "מאושר בלבד" - אבל ספירות הדשבורד (בעיות/דורש עדכון/
      // ללא תמונה) נספרות על כל הסטטוסים, אז בלי לנקות את הסטטוס כאן הקליק מהדשבורד היה מציג
      // פחות פעילויות ממה שהכרטיס הבטיח. pending הוא היחיד שבכוונה כן מצמצם לסטטוס ספציפי.
      $statusFilter.value = filter === 'pending' ? 'pending' : '';
    }
    const editId = params.get('edit');
    if (editId) {
      // הפעילות היעד עשויה להיות בכל סטטוס/קטגוריה/אזור - מנקים את כל הפילטרים ופותחים את כל
      // האזורים כדי שהשורה שלה תהיה בוודאות מרונדרת וגלויה (לא display:none תחת אזור מכווץ).
      $statusFilter.value = '';
      $categoryFilter.value = '';
      collapsedRegions = new Set();
      setTimeout(() => {
        const row = document.querySelector('.row[data-row-id="' + editId + '"]');
        if (row) {
          row.scrollIntoView({ behavior: 'smooth', block: 'center' });
          const editBtn = row.querySelector('.edit-btn') || row;
          editBtn.click();
        }
      }, 200);
    }
  }

  function switchTab(name) {
    Object.entries($tabPanels).forEach(([key, el]) => { el.style.display = key === name ? 'block' : 'none'; });
    $tabButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === name));
  }

  $tabButtons.forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  $search.addEventListener('input', renderAll);
  $statusFilter.addEventListener('change', renderAll);
  $categoryFilter.addEventListener('change', renderAll);

  async function handleActivityListClick(e) {
    const header = e.target.closest('.region-header');
    if (header) {
      const region = header.dataset.region;
      if (collapsedRegions.has(region)) collapsedRegions.delete(region); else collapsedRegions.add(region);
      renderAll();
      return;
    }

    const editBtn = e.target.closest('.edit-btn');
    if (editBtn) {
      const id = editBtn.dataset.id;
      const row = e.currentTarget.querySelector('.row[data-row-id="' + id + '"]');
      const existingForm = row ? row.querySelector('.edit-form') : null;
      if (existingForm) {
        existingForm.remove();
        return;
      }
      const activity = allActivities.find((a) => a.id === id);
      if (row && activity) {
        row.insertAdjacentHTML('beforeend', renderEditForm(activity));
      }
      return;
    }

    const verifyBtn = e.target.closest('.verify-row-btn');
    if (verifyBtn) {
      const id = verifyBtn.dataset.id;
      verifyBtn.disabled = true;
      verifyBtn.textContent = '...';
      try {
        const res = await fetch('/api/manage/bulk-verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [id], days: null }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
        const idx = allActivities.findIndex((a) => a.id === id);
        if (idx !== -1) { allActivities[idx].last_verified_at = new Date().toISOString(); allActivities[idx].next_review_at = null; }
        renderAll();
      } catch (err) {
        verifyBtn.disabled = false;
        verifyBtn.textContent = '✓ אמת';
        alert('שגיאה באימות: ' + err.message);
      }
      return;
    }

    const approveBtn = e.target.closest('.approve-btn');
    if (approveBtn) {
      const id = approveBtn.dataset.id;
      approveBtn.disabled = true;
      approveBtn.textContent = '...';
      try {
        const res = await fetch('/api/manage/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, fields: { status: 'approved' } }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
        const idx = allActivities.findIndex((a) => a.id === id);
        if (idx !== -1) allActivities[idx] = data.activity;
        renderAll();
      } catch (err) {
        approveBtn.disabled = false;
        approveBtn.textContent = 'אשר';
        alert('שגיאה באישור: ' + err.message);
      }
      return;
    }

    const archiveBtn = e.target.closest('.pending-archive-btn');
    if (archiveBtn) {
      const id = archiveBtn.dataset.id;
      archiveBtn.disabled = true;
      archiveBtn.textContent = '...';
      try {
        const res = await fetch('/api/manage/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, fields: { status: 'archived' } }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
        const idx = allActivities.findIndex((a) => a.id === id);
        if (idx !== -1) allActivities[idx] = data.activity;
        renderAll();
      } catch (err) {
        archiveBtn.disabled = false;
        archiveBtn.textContent = 'ארכב';
        alert('שגיאה בארכוב: ' + err.message);
      }
      return;
    }

    const photoDeleteBtn = e.target.closest('.edit-photo-delete');
    if (photoDeleteBtn) {
      const photoId = photoDeleteBtn.dataset.photoId;
      const activityId = photoDeleteBtn.dataset.activityId;
      photoDeleteBtn.disabled = true;
      try {
        const res = await fetch('/api/manage/delete-photo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: photoId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
        const activity = allActivities.find((a) => a.id === activityId);
        if (activity) activity.activity_images = (activity.activity_images || []).filter((img) => img.id !== photoId);
        photoDeleteBtn.closest('.edit-photo-item').remove();
        renderMissingPhotos();
      } catch (err) {
        photoDeleteBtn.disabled = false;
        alert('שגיאה במחיקת התמונה: ' + err.message);
      }
      return;
    }

    const benefitAddToggle = e.target.closest('.benefit-add-toggle');
    if (benefitAddToggle) {
      const activityId = benefitAddToggle.dataset.activityId;
      const container = benefitAddToggle.closest('.benefits-block');
      const existingForm = container.querySelector('.benefit-form');
      if (existingForm) { existingForm.remove(); return; }
      container.insertAdjacentHTML('beforeend',
        '<div class="benefit-form" data-mode="add" data-activity-id="' + activityId + '">' +
          benefitFieldsHtml(null) +
          '<div class="form-actions">' +
            '<button class="save-btn benefit-save-btn">שמירת הטבה</button>' +
            '<button class="cancel-btn benefit-cancel-btn">ביטול</button>' +
          '</div>' +
        '</div>'
      );
      return;
    }

    const benefitEditBtn = e.target.closest('.benefit-edit-btn');
    if (benefitEditBtn) {
      const benefitId = benefitEditBtn.dataset.benefitId;
      const activityId = benefitEditBtn.dataset.activityId;
      const row = benefitEditBtn.closest('.benefit-row');
      const existingForm = row.nextElementSibling && row.nextElementSibling.classList.contains('benefit-form') ? row.nextElementSibling : null;
      if (existingForm) { existingForm.remove(); return; }
      const activity = allActivities.find((a) => a.id === activityId);
      const benefit = activity && (activity.activity_benefits || []).find((b) => b.id === benefitId);
      if (!benefit) return;
      row.insertAdjacentHTML('afterend',
        '<div class="benefit-form" data-mode="edit" data-benefit-id="' + benefitId + '" data-activity-id="' + activityId + '">' +
          benefitFieldsHtml(benefit) +
          '<div class="form-actions">' +
            '<button class="save-btn benefit-save-btn">שמירה</button>' +
            '<button class="cancel-btn benefit-cancel-btn">ביטול</button>' +
          '</div>' +
        '</div>'
      );
      return;
    }

    const benefitCancelBtn = e.target.closest('.benefit-cancel-btn');
    if (benefitCancelBtn) {
      benefitCancelBtn.closest('.benefit-form').remove();
      return;
    }

    const benefitSaveBtn = e.target.closest('.benefit-save-btn');
    if (benefitSaveBtn) {
      const form = benefitSaveBtn.closest('.benefit-form');
      const mode = form.dataset.mode;
      const activityId = form.dataset.activityId;
      const fields = {};
      form.querySelectorAll('[data-field]').forEach((el) => {
        const key = el.dataset.field;
        let val = el.value;
        if (key === 'special_price') val = val === '' ? null : Number(val);
        else if (val === '') val = null;
        fields[key] = val;
      });
      benefitSaveBtn.disabled = true;
      benefitSaveBtn.textContent = '...';
      try {
        const url = mode === 'add' ? '/api/manage/benefit-add' : '/api/manage/benefit-update';
        const body = mode === 'add' ? { activityId, fields } : { id: form.dataset.benefitId, fields };
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
        const activity = allActivities.find((a) => a.id === activityId);
        if (activity) {
          const list = activity.activity_benefits || [];
          activity.activity_benefits = mode === 'add' ? [...list, data.benefit] : list.map((b) => (b.id === data.benefit.id ? data.benefit : b));
        }
        const container = form.closest('.benefits-block');
        if (container && activity) container.outerHTML = renderEditBenefits(activity);
      } catch (err) {
        benefitSaveBtn.disabled = false;
        benefitSaveBtn.textContent = mode === 'add' ? 'שמירת הטבה' : 'שמירה';
        alert('שגיאה בשמירת ההטבה: ' + err.message);
      }
      return;
    }

    const benefitDeleteBtn = e.target.closest('.benefit-delete-btn');
    if (benefitDeleteBtn) {
      if (!benefitDeleteBtn.classList.contains('confirming')) {
        benefitDeleteBtn.classList.add('confirming');
        benefitDeleteBtn.textContent = 'לאשר מחיקה?';
        setTimeout(() => {
          if (benefitDeleteBtn.isConnected && benefitDeleteBtn.classList.contains('confirming')) {
            benefitDeleteBtn.classList.remove('confirming');
            benefitDeleteBtn.textContent = 'מחק';
          }
        }, 3000);
        return;
      }
      const benefitId = benefitDeleteBtn.dataset.benefitId;
      const activityId = benefitDeleteBtn.dataset.activityId;
      benefitDeleteBtn.disabled = true;
      try {
        const res = await fetch('/api/manage/benefit-delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: benefitId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
        const activity = allActivities.find((a) => a.id === activityId);
        if (activity) activity.activity_benefits = (activity.activity_benefits || []).filter((b) => b.id !== benefitId);
        const container = benefitDeleteBtn.closest('.benefits-block');
        if (container && activity) container.outerHTML = renderEditBenefits(activity);
      } catch (err) {
        benefitDeleteBtn.disabled = false;
        benefitDeleteBtn.classList.remove('confirming');
        benefitDeleteBtn.textContent = 'מחק';
        alert('שגיאה במחיקת ההטבה: ' + err.message);
      }
      return;
    }

    const geocodeBtn = e.target.closest('.geocode-btn');
    if (geocodeBtn) {
      const locationId = geocodeBtn.dataset.locationId;
      const activityId = geocodeBtn.dataset.activityId;
      const statusEl = e.currentTarget.querySelector('[data-geo-status-for="' + activityId + '"]');
      geocodeBtn.disabled = true;
      geocodeBtn.textContent = 'מאתר...';
      try {
        const res = await fetch('/api/manage/geocode-location', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ locationId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
        const activity = allActivities.find((a) => a.id === activityId);
        if (activity && activity.location) { activity.location.lat = data.lat; activity.location.lng = data.lng; }
        if (statusEl) statusEl.textContent = '📍 יש קואורדינטות למפה';
      } catch (err) {
        alert('שגיאה באיתור קואורדינטות: ' + err.message);
      } finally {
        geocodeBtn.disabled = false;
        geocodeBtn.textContent = '🌍 אתר קואורדינטות מחדש';
      }
      return;
    }

    const cancelBtn = e.target.closest('.cancel-btn');
    if (cancelBtn) {
      const form = e.currentTarget.querySelector('.edit-form[data-edit-for="' + cancelBtn.dataset.id + '"]');
      if (form) form.remove();
      return;
    }

    const saveBtn = e.target.closest('.save-btn');
    if (saveBtn) {
      const id = saveBtn.dataset.id;
      const form = e.currentTarget.querySelector('.edit-form[data-edit-for="' + id + '"]');
      const statusEl = form.querySelector('[data-edit-status-for="' + id + '"]');
      const val = (elId) => document.getElementById(elId).value;
      const numOrNull = (elId) => { const v = val(elId).trim(); return v === '' ? null : Number(v); };
      const strOrNull = (elId) => { const v = val(elId).trim(); return v === '' ? null : v; };

      const fields = {
        name: val('f_name'),
        status: val('f_status'),
        entity_type: val('f_entity_type'),
        category: strOrNull('f_category'),
        min_age: numOrNull('f_min_age'),
        max_age: numOrNull('f_max_age'),
        price_type: strOrNull('f_price_type'),
        price_amount: numOrNull('f_price_amount'),
        duration_minutes: numOrNull('f_duration_minutes'),
        indoor_outdoor: strOrNull('f_indoor_outdoor'),
        booking_requirement: strOrNull('f_booking_requirement'),
        description: strOrNull('f_description'),
        location_detail: strOrNull('f_location_detail'),
        weather_suitable: readTagGroup('f_weather'),
        amenities: readTagGroup('f_amenities'),
        family_fit: readTagGroup('f_family_fit'),
      };
      const location = {
        name: val('f_loc_name'),
        city: val('f_loc_city'),
        region: val('f_loc_region'),
        address: val('f_loc_address'),
      };

      saveBtn.disabled = true;
      statusEl.className = 'edit-status';
      statusEl.textContent = 'שומר...';
      try {
        const res = await fetch('/api/manage/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, fields, location: location.name ? location : null }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
        const idx = allActivities.findIndex((a) => a.id === id);
        if (idx !== -1) allActivities[idx] = data.activity;
        statusEl.className = 'edit-status success';
        statusEl.textContent = '✓ נשמר';
        setTimeout(() => renderAll(), 500);
      } catch (err) {
        saveBtn.disabled = false;
        statusEl.className = 'edit-status error';
        statusEl.textContent = 'שגיאה: ' + err.message;
      }
      return;
    }

    const deleteBtn = e.target.closest('.delete-btn');
    if (deleteBtn) {
      if (!deleteBtn.classList.contains('confirming')) {
        deleteBtn.classList.add('confirming');
        deleteBtn.textContent = 'לאשר מחיקה?';
        setTimeout(() => {
          if (deleteBtn.isConnected) { deleteBtn.classList.remove('confirming'); deleteBtn.textContent = 'מחק'; }
        }, 4000);
        return;
      }
      const id = deleteBtn.dataset.id;
      deleteBtn.disabled = true;
      deleteBtn.textContent = 'מוחק...';
      try {
        const res = await fetch('/api/delete-activities', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [id] }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
        const result = data.results[id];
        if (!result || !result.ok) throw new Error((result && result.error) || 'שגיאה לא ידועה');
        allActivities = allActivities.filter((a) => a.id !== id);
        const row = e.currentTarget.querySelector('.row[data-row-id="' + id + '"]');
        if (row) row.classList.add('is-removed');
        renderAll();
      } catch (err) {
        deleteBtn.disabled = false;
        deleteBtn.classList.remove('confirming');
        deleteBtn.textContent = 'מחק';
        alert('שגיאה במחיקה: ' + err.message);
      }
      return;
    }

    const rowHead = e.target.closest('.row-head');
    if (rowHead && !e.target.closest('a, button, input, label')) {
      const row = rowHead.closest('.row');
      const id = row.dataset.rowId;
      const existingForm = row.querySelector('.edit-form');
      if (existingForm) {
        existingForm.remove();
        return;
      }
      const activity = allActivities.find((a) => a.id === id);
      if (activity) {
        row.insertAdjacentHTML('beforeend', renderEditForm(activity));
      }
    }
  }

  $regions.addEventListener('click', handleActivityListClick);
  $missingPhotosList.addEventListener('click', handleActivityListClick);
  $statusList.addEventListener('click', handleActivityListClick);

  $regions.addEventListener('change', (e) => {
    const box = e.target.closest('.row-select');
    if (!box) return;
    const id = box.dataset.id;
    if (box.checked) selectedIds.add(id); else selectedIds.delete(id);
    updateBulkSelectBar();
  });

  // אשר/שנה-קטגוריה/שנה-אזור/אמת - כולם קוראים לאותו endpoint מרוכז יחיד (bulk-update/
  // bulk-verify/bulk-region), בקשת רשת אחת לכל הפעילויות המסומנות ולא לולאה של בקשות בודדות
  // כמו שהיה קודם ל"אשר" - מהיר יותר וגם אטומי יותר בצד השרת.
  async function runBulkAction(btn, url, body, doneLabel) {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '...';
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, ...body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      selectedIds.clear();
      await load();
    } catch (err) {
      alert('שגיאה: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  $bulkApproveBtn.addEventListener('click', () => (
    runBulkAction($bulkApproveBtn, '/api/manage/bulk-update', { fields: { status: 'approved' } })
  ));

  $bulkCategorySelect.addEventListener('change', () => {
    if (!$bulkCategorySelect.value) return;
    runBulkAction($bulkCategorySelect, '/api/manage/bulk-update', { fields: { category: $bulkCategorySelect.value } })
      .then(() => { $bulkCategorySelect.value = ''; });
  });

  $bulkRegionSelect.addEventListener('change', () => {
    if (!$bulkRegionSelect.value) return;
    runBulkAction($bulkRegionSelect, '/api/manage/bulk-region', { region: $bulkRegionSelect.value })
      .then(() => { $bulkRegionSelect.value = ''; });
  });

  $bulkVerifyBtn.addEventListener('click', () => {
    const days = $bulkVerifyDays.value ? Number($bulkVerifyDays.value) : null;
    runBulkAction($bulkVerifyBtn, '/api/manage/bulk-verify', { days });
  });

  $bulkDeleteBtn.addEventListener('click', async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (!$bulkDeleteBtn.classList.contains('confirming')) {
      $bulkDeleteBtn.classList.add('confirming');
      $bulkDeleteBtn.textContent = 'לאשר מחיקת ' + ids.length + '?';
      setTimeout(() => {
        if ($bulkDeleteBtn.isConnected && $bulkDeleteBtn.classList.contains('confirming')) {
          $bulkDeleteBtn.classList.remove('confirming');
          $bulkDeleteBtn.textContent = 'מחק';
        }
      }, 4000);
      return;
    }
    $bulkDeleteBtn.disabled = true;
    $bulkDeleteBtn.textContent = 'מוחק...';
    try {
      const res = await fetch('/api/delete-activities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      selectedIds.clear();
      await load();
    } catch (err) {
      alert('שגיאה במחיקה: ' + err.message);
    } finally {
      $bulkDeleteBtn.disabled = false;
      $bulkDeleteBtn.classList.remove('confirming');
      $bulkDeleteBtn.textContent = 'מחק';
    }
  });

  // ניקוי פעילויות שפג תוקפן - קליק ראשון מביא תצוגה מקדימה (dryRun) ומבקש אישור, קליק שני
  // (תוך 8 שניות) מבצע בפועל. אותו אינדוס "לאשר?" כמו כפתור מחיקה בודד למעלה, רק ברמת קבוצה.
  async function cleanupExpired() {
    if ($cleanupExpired.classList.contains('confirming')) {
      $cleanupExpired.disabled = true;
      $cleanupExpired.textContent = 'מוחק...';
      try {
        const res = await fetch('/api/manage/cleanup-expired', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dryRun: false }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
        const count = data.activities.length;
        $cleanupExpiredStatus.textContent = 'נמחקו בהצלחה ' + count + ' פעילויות שפג תוקפן. 🧹';
        await load();
      } catch (err) {
        $cleanupExpiredStatus.textContent = 'שגיאה: ' + err.message;
      } finally {
        $cleanupExpired.disabled = false;
        $cleanupExpired.classList.remove('confirming');
        $cleanupExpired.textContent = '🧹 ניקוי פעילויות שפג תוקפן';
      }
      return;
    }

    $cleanupExpired.disabled = true;
    $cleanupExpiredStatus.textContent = 'בודק...';
    try {
      const res = await fetch('/api/manage/cleanup-expired', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
      const found = data.activities;
      if (found.length === 0) {
        $cleanupExpiredStatus.textContent = 'אין פעילויות שפג תוקפן כרגע. 🎉';
        return;
      }
      const namesPreview = found.slice(0, 5).map((a) => a.name).join(', ') + (found.length > 5 ? ' ...' : '');
      $cleanupExpiredStatus.textContent = 'ימחקו: ' + namesPreview;
      $cleanupExpired.classList.add('confirming');
      $cleanupExpired.textContent = 'לאשר מחיקת ' + found.length + ' פעילויות?';
      setTimeout(() => {
        if (!$cleanupExpired.isConnected) return;
        if (!$cleanupExpired.classList.contains('confirming')) return;
        $cleanupExpired.classList.remove('confirming');
        $cleanupExpired.textContent = '🧹 ניקוי פעילויות שפג תוקפן';
        $cleanupExpiredStatus.textContent = '';
      }, 8000);
    } catch (err) {
      $cleanupExpiredStatus.textContent = 'שגיאה: ' + err.message;
    } finally {
      $cleanupExpired.disabled = false;
    }
  }

  $cleanupExpired.addEventListener('click', cleanupExpired);

  // פעילות "לאישור" רק אם היא ממתינה וגם כבר יש לה תמונה מאושרת (או שסומנה "אשר ללא תמונה") -
  // כך פעילות בלי תמונה לא מופיעה כאן בכלל, רק ב"פעילויות ללא תמונה" - ראו computeMissingPhotoActivities.
  function computePendingActivities() {
    return allActivities.filter((a) => a.status === 'pending' && (activityHasApprovedPhoto(a) || a.photo_skipped));
  }

  function updateStatusBulkBar() {
    const count = selectedStatusIds.size;
    const pendingCount = computePendingActivities().length;
    $approveSelected.disabled = count === 0;
    $approveSelected.textContent = count > 0 ? 'אשר ' + count + ' פעילויות שנבחרו' : 'אשר את כל הפעילויות המסומנות';
    $statusSelectAll.checked = pendingCount > 0 && count === pendingCount;
  }

  function renderPendingRowView(a) {
    const locationLabel = a.location ? [a.location.name, a.location.city].filter(Boolean).join(' · ') : 'ללא מיקום';
    const sourceLink = a.source_url ? '<a class="source-link" href="' + escapeHtml(a.source_url) + '" target="_blank" rel="noopener noreferrer">🔗 מקור</a>' : '';
    const officialLink = a.official_url ? '<a class="source-link" href="' + escapeHtml(a.official_url) + '" target="_blank" rel="noopener noreferrer">🌐 אתר רשמי</a>' : '';
    return '<div class="row-head">' +
      '<input type="checkbox" class="status-row-select" data-id="' + a.id + '"' + (selectedStatusIds.has(a.id) ? ' checked' : '') + '>' +
      (a.category ? '<span class="cat-badge">' + escapeHtml(a.category) + '</span>' : '') +
      '<span class="row-title">' + escapeHtml(a.name) + '</span>' +
      '<span class="row-meta">' + escapeHtml(locationLabel) + '</span>' +
      sourceLink +
      officialLink +
      '<span class="row-actions">' +
        '<button class="icon-btn approve-btn" data-id="' + a.id + '">אשר</button>' +
        '<button class="icon-btn danger pending-archive-btn" data-id="' + a.id + '">ארכב</button>' +
      '</span>' +
    '</div>';
  }

  function renderStatusList() {
    const pending = computePendingActivities();
    const validIds = new Set(pending.map((a) => a.id));
    Array.from(selectedStatusIds).forEach((id) => { if (!validIds.has(id)) selectedStatusIds.delete(id); });
    $tabPendingCount.textContent = pending.length ? ' (' + pending.length + ')' : '';
    if (pending.length === 0) {
      $statusSummary.textContent = 'אין פעילויות שממתינות לאישור. 🎉';
      $statusList.innerHTML = '';
    } else {
      $statusSummary.textContent = 'נמצאו ' + pending.length + ' פעילויות שממתינות לאישור.';
      $statusList.innerHTML = pending.map((a) => '<div class="row" data-row-id="' + a.id + '">' + renderPendingRowView(a) + '</div>').join('');
    }
    updateStatusBulkBar();
  }

  $statusList.addEventListener('change', (e) => {
    const box = e.target.closest('.status-row-select');
    if (!box) return;
    const id = box.dataset.id;
    if (box.checked) selectedStatusIds.add(id); else selectedStatusIds.delete(id);
    updateStatusBulkBar();
  });

  $statusSelectAll.addEventListener('change', () => {
    if ($statusSelectAll.checked) {
      computePendingActivities().forEach((a) => selectedStatusIds.add(a.id));
    } else {
      selectedStatusIds.clear();
    }
    $statusList.querySelectorAll('.status-row-select').forEach((box) => { box.checked = $statusSelectAll.checked; });
    updateStatusBulkBar();
  });

  $approveSelected.addEventListener('click', async () => {
    const ids = Array.from(selectedStatusIds);
    if (ids.length === 0) return;
    $approveSelected.disabled = true;
    $approveSelected.textContent = 'מאשר...';
    for (const id of ids) {
      try {
        const res = await fetch('/api/manage/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, fields: { status: 'approved' } }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'שגיאה לא ידועה');
        const idx = allActivities.findIndex((a) => a.id === id);
        if (idx !== -1) allActivities[idx] = data.activity;
        selectedStatusIds.delete(id);
      } catch (err) {
        alert('שגיאה באישור פעילות: ' + err.message);
      }
    }
    renderAll();
  });

  load();
</script>
</body>
</html>`;
}

module.exports = { renderManagePage };
