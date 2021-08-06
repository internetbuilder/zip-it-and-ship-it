const { startZip, addZipFile, endZip } = require('./archive')
const { addToolchainFile } = require('./toolchain')

const zipBinary = async function ({ srcPath, destPath, filename, stat, runtime }) {
  const { archive, output } = startZip(destPath)

  addZipFile(archive, srcPath, filename, stat)
  addToolchainFile({ archive, runtime })

  await endZip(archive, output)
}

module.exports = { zipBinary }
