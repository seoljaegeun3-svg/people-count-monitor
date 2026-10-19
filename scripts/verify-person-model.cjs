const { loadModel } = require('../person-detector');
const model = require('../models/manifest.json');

loadModel().then(bytes => {
  console.log(`${model.file}: ${bytes.length} bytes, SHA-256 ${model.sha256} verified`);
}).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
