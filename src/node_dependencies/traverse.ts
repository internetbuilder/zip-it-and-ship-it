import { dirname } from 'path'

import { getModuleName } from './module'
import { getNestedDependencies, handleModuleNotFound } from './nested'
import { getPackageJson, PackageJson } from './package_json'
import { getPublishedFiles } from './published'
import { resolvePackage } from './resolve'
import { getSideFiles } from './side_files'

const EXCLUDED_MODULES = new Set(['aws-sdk'])

export interface State {
  localFiles: Set<string>
  moduleNames: Set<string>
  modulePaths: Set<string>
}

// Local cache used for optimizing the traversal of module dependencies.
export const getNewCache = (): State => ({ localFiles: new Set(), moduleNames: new Set(), modulePaths: new Set() })

// When a file requires a module, we find its path inside `node_modules` and
// use all its published files. We also recurse on the module's dependencies.
export const getDependencyPathsForDependency = async function ({
  dependency,
  basedir,
  state,
  packageJson,
  pluginsModulesPath,
}: {
  dependency: string
  basedir: string
  state: State
  packageJson: PackageJson
  pluginsModulesPath?: string
}) {
  const moduleName = getModuleName(dependency)

  // Happens when doing require("@scope") (not "@scope/name") or other oddities
  // Ignore those.
  if (moduleName === null) {
    return []
  }

  try {
    return await getDependenciesForModuleName({ moduleName, basedir, state, pluginsModulesPath })
  } catch (error) {
    return handleModuleNotFound({ error, moduleName, packageJson })
  }
}

export const getDependencyNamesAndPathsForDependencies = async function ({
  dependencies: dependencyNames,
  basedir,
  state = getNewCache(),
  pluginsModulesPath,
}: {
  dependencies: string[]
  basedir: string
  state?: State
  pluginsModulesPath?: string
}) {
  const packageJson = await getPackageJson(basedir)
  const dependencies = await Promise.all(
    dependencyNames.map((dependencyName) =>
      getDependencyNamesAndPathsForDependency({
        dependency: dependencyName,
        basedir,
        state,
        packageJson,
        pluginsModulesPath,
      }),
    ),
  )
  const moduleNames = new Set(dependencies.flatMap((dependency) => [...dependency.moduleNames]))
  const paths = new Set(dependencies.flatMap((dependency) => [...dependency.paths]))

  return {
    moduleNames: [...moduleNames],
    paths: [...paths],
  }
}

export const getDependencyNamesAndPathsForDependency = async function ({
  dependency,
  basedir,
  state = getNewCache(),
  packageJson,
  pluginsModulesPath,
}: {
  dependency: string
  basedir: string
  state?: State
  packageJson: PackageJson
  pluginsModulesPath?: string
}) {
  try {
    const paths = await getDependencyPathsForDependency({ dependency, basedir, state, packageJson, pluginsModulesPath })

    return {
      moduleNames: [...state.moduleNames],
      paths,
    }
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') {
      return {
        moduleNames: [],
        paths: [],
      }
    }

    throw error
  }
}

const getDependenciesForModuleName = async function ({
  moduleName,
  basedir,
  state,
  pluginsModulesPath,
}: {
  moduleName: string
  basedir: string
  state: State
  pluginsModulesPath?: string
}) {
  if (isExcludedModule(moduleName)) {
    return []
  }

  // Find the Node.js module directory path
  const packagePath = await resolvePackage(moduleName, [basedir, pluginsModulesPath].filter(Boolean) as string[])

  if (packagePath === undefined) {
    return []
  }

  const modulePath = dirname(packagePath)

  if (state.modulePaths.has(modulePath)) {
    return []
  }

  state.moduleNames.add(moduleName)
  state.modulePaths.add(modulePath)

  // The path depends on the user's build, i.e. must be dynamic
  // eslint-disable-next-line import/no-dynamic-require, node/global-require
  const packageJson: PackageJson = require(packagePath)

  const [publishedFiles, sideFiles, depsPaths] = await Promise.all([
    getPublishedFiles(modulePath),
    getSideFiles(modulePath, moduleName),
    getNestedModules({ modulePath, state, packageJson, pluginsModulesPath }),
  ])
  return [...publishedFiles, ...sideFiles, ...depsPaths]
}

const isExcludedModule = function (moduleName: string) {
  return EXCLUDED_MODULES.has(moduleName) || moduleName.startsWith('@types/')
}

const getNestedModules = async function ({
  modulePath,
  state,
  packageJson,
  pluginsModulesPath,
}: {
  modulePath: string
  state: State
  packageJson: PackageJson
  pluginsModulesPath?: string
}): Promise<string[]> {
  const dependencies = getNestedDependencies(packageJson)

  const depsPaths = await Promise.all(
    dependencies.map((dependency) =>
      getDependencyPathsForDependency({ dependency, basedir: modulePath, state, packageJson, pluginsModulesPath }),
    ),
  )
  // TODO: switch to Array.flat() once we drop support for Node.js < 11.0.0
  // eslint-disable-next-line unicorn/prefer-spread
  return [].concat(...(depsPaths as any))
}
