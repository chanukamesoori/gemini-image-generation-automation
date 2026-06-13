const fs = require('fs');
const path = require('path');

const CSV_HEADERS = 'row,prompt,filename,status,error,timestamp,method\n';

function escapeCsv(value) {
  const text = value === undefined || value === null ? '' : String(value);

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function initLog(logDir) {
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'results.csv'), CSV_HEADERS, 'utf8');
}

function saveLog(logDir, entry) {
  fs.mkdirSync(logDir, { recursive: true });

  const row = [
    entry.row,
    entry.prompt,
    entry.filename,
    entry.status,
    entry.error,
    entry.timestamp,
    entry.method
  ].map(escapeCsv).join(',');

  fs.appendFileSync(path.join(logDir, 'results.csv'), `${row}\n`, 'utf8');
}

module.exports = {
  initLog,
  saveLog
};
