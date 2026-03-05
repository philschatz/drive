const fs = require('fs');
const path = require('path');

module.exports = async function () {
  const dir = path.resolve(__dirname, '..', '.data-jest');
  fs.rmSync(dir, { recursive: true, force: true });
};
