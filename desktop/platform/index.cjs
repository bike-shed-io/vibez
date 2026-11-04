const { createPosix } = require('./posix.cjs');
const { createWindows } = require('./windows.cjs');

function createPlatform(options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'win32') return createWindows(options);
  if (platform === 'linux' || platform === 'darwin') return createPosix({ ...options, platform });
  throw new Error(`Unsupported desktop platform: ${platform}`);
}

module.exports = { createPlatform };
