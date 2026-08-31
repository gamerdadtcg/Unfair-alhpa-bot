const path = require('path');
const fs = require('fs');

function loadMockCandidates() {
  const dir = path.join(__dirname);
  return ['goodMint', 'goodMintRh', 'farmMint', 'repeatMint'].map(name =>
    JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'))
  );
}

module.exports = { loadMockCandidates };
