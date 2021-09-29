const sideFile1 = require('./lib/side_file')
const sideFile2 = require('./lib/side_file.js')
const sideFile3 = require('./lib/side_file.cjs')
const sideFile4 = require('./lib/side_file.json')

const sideFiles = [sideFile1, sideFile2, sideFile3, sideFile4]

let html = 404

try {
  html = require('./index.html')
} catch (_) {
  // no-op
}

module.exports = { html, sideFiles }
