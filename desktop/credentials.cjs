const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

function createCredentialStore(platform) {
  const file = platform.locations.token;
  return {
    async save(origin, token) {
      const encrypted = await platform.encodeCredentials(JSON.stringify({ origin, token }));
      platform.prepareData();
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, encrypted, platform.fileOptions);
        fs.renameSync(temporary, file);
        platform.protectFile(file);
      } finally { fs.rmSync(temporary, { force: true }); }
    },
    async load(origin) {
      if (!fs.existsSync(file)) return null;
      platform.protectFile(file);
      const saved = JSON.parse(await platform.decodeCredentials(fs.readFileSync(file)));
      return saved.origin === origin && typeof saved.token === 'string' ? saved.token : null;
    },
    clear() { fs.rmSync(file, { force: true }); },
  };
}

module.exports = { createCredentialStore };
