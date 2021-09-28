import { dirname, basename, normalize } from 'path'

import findUp from 'find-up'

import { not as notJunk } from 'junk'
import * as precinct from 'precinct'
import type { Stats } from 'fs'
import { PackageJson } from './package_json'

import { listImports } from '../runtimes/node/list_imports'

import { getPackageJson } from './package_json'

import { resolvePathPreserveSymlinks } from './resolve'

import { getExternalAndIgnoredModulesFromSpecialCases } from './special_cases'
import {
  getDependencyNamesAndPathsForDependencies,
  getDependencyPathsForDependency,
  getDependencyNamesAndPathsForDependency,
  getNewCache,
  State,
} from './traverse'
import { getTreeFiles } from './tree_files'
import { shouldTreeShake } from './tree_shake'

const AUTO_PLUGINS_DIR = '.netlify/plugins/'

export const getPluginsModulesPath = (srcDir: string) =>
  findUp(`${AUTO_PLUGINS_DIR}node_modules`, { cwd: srcDir, type: 'directory' })

// Retrieve the paths to the Node.js files to zip.
// We only include the files actually needed by the function because AWS Lambda
// has a size limit for the zipped file. It also makes cold starts faster.
export const listFilesUsingLegacyBundler = async function ({
  featureFlags,
  srcPath,
  mainFile,
  srcDir,
  stat,
  pluginsModulesPath,
}: {
  featureFlags: Record<string, boolean>
  srcPath: string
  mainFile: string
  srcDir: string
  stat: Stats
  pluginsModulesPath?: string
}) {
  const [treeFiles, depFiles] = await Promise.all([
    getTreeFiles(srcPath, stat),
    getDependencies(mainFile, srcDir, pluginsModulesPath, featureFlags),
  ])
  const files = [...treeFiles, ...depFiles].map(normalize)
  const uniqueFiles = [...new Set(files)]

  // We sort so that the archive's checksum is deterministic.
  // Mutating is fine since `Array.filter()` returns a shallow copy
  const filteredFiles = uniqueFiles.filter(isNotJunk).sort()
  return filteredFiles
}

// Remove temporary files like *~, *.swp, etc.
const isNotJunk = function (file: string) {
  return notJunk(basename(file))
}

// Retrieve all the files recursively required by a Node.js file
const getDependencies = async function (
  mainFile: string,
  srcDir: string,
  pluginsModulesPath: string | undefined,
  featureFlags: Record<string, boolean>,
) {
  const packageJson = await getPackageJson(srcDir)
  const state = getNewCache()

  try {
    return await getFileDependencies({ featureFlags, path: mainFile, packageJson, pluginsModulesPath, state })
  } catch (error) {
    error.message = `In file "${mainFile}"\n${error.message}`
    throw error
  }
}

const getFileDependencies = async function ({
  featureFlags,
  path,
  packageJson,
  pluginsModulesPath,
  state,
  treeShakeNext,
}: {
  featureFlags: Record<string, boolean>
  path: string
  packageJson: PackageJson
  pluginsModulesPath?: string
  state: State
  treeShakeNext?: boolean
}): Promise<string[]> {
  if (state.localFiles.has(path)) {
    return []
  }

  state.localFiles.add(path)

  const basedir = dirname(path)
  const dependencies = featureFlags.parseWithEsbuild
    ? await listImports({ path })
    : precinct.paperwork(path, { includeCore: false })
  const depsPaths = await Promise.all(
    dependencies.filter(Boolean).map((dependency) =>
      getImportDependencies({
        dependency,
        basedir,
        featureFlags,
        packageJson,
        pluginsModulesPath,
        state,
        treeShakeNext,
      }),
    ),
  )
  // TODO: switch to Array.flat() once we drop support for Node.js < 11.0.0
  // eslint-disable-next-line unicorn/prefer-spread
  return [].concat(...(depsPaths as any))
}

const getImportDependencies = function ({
  dependency,
  basedir,
  featureFlags,
  packageJson,
  pluginsModulesPath,
  state,
  treeShakeNext,
}: {
  dependency: string
  basedir: string
  featureFlags: Record<string, boolean>
  packageJson: PackageJson
  pluginsModulesPath?: string
  state: State
  treeShakeNext?: boolean
}) {
  const shouldTreeShakeNext = treeShakeNext || isNextOnNetlify(dependency)
  if (shouldTreeShake(dependency, shouldTreeShakeNext)) {
    return getTreeShakedDependencies({
      dependency,
      basedir,
      featureFlags,
      packageJson,
      pluginsModulesPath,
      state,
      treeShakeNext: shouldTreeShakeNext,
    })
  }

  return getDependencyPathsForDependency({ dependency, basedir, state, packageJson, pluginsModulesPath })
}

const isNextOnNetlify = function (dependency: string) {
  return basename(dependency, '.js') === 'renderNextPage'
}

// When a file requires another one, we apply the top-level logic recursively
const getTreeShakedDependencies = async function ({
  dependency,
  basedir,
  featureFlags,
  packageJson,
  pluginsModulesPath,
  state,
  treeShakeNext,
}: {
  dependency: string
  basedir?: string
  featureFlags: Record<string, boolean>
  packageJson: PackageJson
  pluginsModulesPath?: string
  state: State
  treeShakeNext?: boolean
}) {
  const path = await resolvePathPreserveSymlinks(dependency, [basedir, pluginsModulesPath].filter(Boolean) as string[])
  const depsPath = await getFileDependencies({
    featureFlags,
    path,
    packageJson,
    pluginsModulesPath,
    state,
    treeShakeNext,
  })
  return [path, ...depsPath]
}

export {
  getDependencyPathsForDependency,
  getDependencyNamesAndPathsForDependencies,
  getDependencyNamesAndPathsForDependency,
  getExternalAndIgnoredModulesFromSpecialCases,
}
