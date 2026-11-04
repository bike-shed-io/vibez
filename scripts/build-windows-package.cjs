#!/usr/bin/env node
require('../desktop/build/windows.cjs').main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
