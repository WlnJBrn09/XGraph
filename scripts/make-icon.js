'use strict';
const fs = require('fs');
const path = require('path');
const build = path.join(__dirname, '..', 'build');
for (const file of ['icon.png', 'icon.ico']) {
  const target = path.join(build, file);
  if (!fs.existsSync(target)) throw new Error(`Missing committed icon: ${target}`);
  console.log(`Ready: ${target}`);
}
