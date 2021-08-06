const { basename, join, normalize } = require('path')
const { promisify } = require('util')

const glob = require('glob')
const unixify = require('unixify')

const pGlob = promisify(glob)

const { startZip, addZipFile, endZip } = require('../../archive')
const { addToolchainFile } = require('../../toolchain')
const { addStat } = require('../../utils/fs')

const createZipArchive = async function ({ destFolder, functionDirectory, runtime }) {
  const destPath = join(destFolder, `${basename(functionDirectory)}.zip`)
  const srcFiles = await getSrcFiles(functionDirectory)
  const { archive, output } = startZip(destPath)
  const srcFilesInfos = await Promise.all(srcFiles.map(addStat))

  // We ensure this is not async, so that the archive's checksum is
  // deterministic. Otherwise it depends on the order the files were added.
  srcFilesInfos.forEach(({ srcFile, stat }) => {
    const filePath = normalizeFilePath({ commonPrefix: functionDirectory, path: srcFile })

    addZipFile(archive, srcFile, filePath, stat)
  })

  addToolchainFile({ archive, runtime })

  await endZip(archive, output)

  return destPath
}

const getSrcFiles = (directory) => pGlob('**', { absolute: true, cwd: directory, nodir: true })

// `adm-zip` and `require()` expect Unix paths.
// We remove the common path prefix.
// With files on different Windows drives, we remove the drive letter.
const normalizeFilePath = function ({ commonPrefix, path }) {
  const normalizedPath = normalize(path)
  const relativePath = normalizedPath.replace(commonPrefix, '')
  const unixPath = unixify(relativePath)

  return unixPath
}

module.exports = { createZipArchive }
