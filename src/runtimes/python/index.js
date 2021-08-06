const { basename, join } = require('path')

const { RUNTIME_PYTHON } = require('../../utils/consts')
const { cachedLstat, cachedReaddir } = require('../../utils/fs')

const { createZipArchive } = require('./zip')

const detectPythonFunction = async ({ fsCache, path }) => {
  const stat = await cachedLstat(fsCache, path)

  if (!stat.isDirectory()) {
    return
  }

  const directoryName = basename(path)
  const files = await cachedReaddir(fsCache, path)
  const mainFileName = `${directoryName}.py`

  if (files.includes(mainFileName)) {
    return mainFileName
  }
}

const findFunctionsInPaths = async function ({ featureFlags, fsCache, paths }) {
  const functions = await Promise.all(
    paths.map(async (path) => {
      if (featureFlags.buildPythonSource !== true) {
        return
      }

      const pythonSourceFile = await detectPythonFunction({ fsCache, path })

      if (!pythonSourceFile) {
        return
      }

      const functionName = basename(path)

      return {
        mainFile: join(path, pythonSourceFile),
        name: functionName,
        srcDir: path,
        srcPath: path,
      }
    }),
  )

  return functions.filter(Boolean)
}

const zipFunction = async function ({ basePath, config, destFolder, runtime, srcDir }) {
  const path = await createZipArchive({ basePath, destFolder, functionDirectory: srcDir, runtime })

  return { config, path }
}

module.exports = { findFunctionsInPaths, name: RUNTIME_PYTHON, zipFunction }
