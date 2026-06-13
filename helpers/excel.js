const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

function readPrompts(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Input Excel file not found: ${filePath}`);
  }

  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames.includes('Sheet1') ? 'Sheet1' : workbook.SheetNames[0];

  if (!sheetName) {
    throw new Error('Input Excel file has no sheets.');
  }

  const worksheet = workbook.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(worksheet, {
    defval: '',
    raw: false
  });

  const prompts = rows
    .map((row, index) => ({
      row: index + 1,
      prompt: String(row.prompt || '').trim(),
      filename: String(row.filename || '').trim()
    }))
    .filter((row) => row.prompt.length > 0);

  for (const row of prompts) {
    if (!row.filename) {
      throw new Error(`Missing filename for Excel row ${row.row}.`);
    }

    if (row.filename !== path.basename(row.filename)) {
      throw new Error(`Invalid filename for Excel row ${row.row}: ${row.filename}`);
    }
  }

  return prompts;
}

module.exports = {
  readPrompts
};
