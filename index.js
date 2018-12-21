const path = require("path");
const fs = require("fs");

const precinct = require("precinct");
const resolve = require("resolve");
const readPkgUp = require("read-pkg-up");
const requirePackageName = require("require-package-name");
const glob = require("glob");
const archiver = require("archiver");
const elfTools = require("elf-tools");

const alwaysIgnored = new Set(["aws-sdk"]);

class Zip {
  constructor(path) {
    this.output = fs.createWriteStream(path);
    this.archive = archiver("zip");
    this.archive.pipe(this.output);
  }

  addLocalFile(path, data) {
    this.archive.file(path, data);
  }

  finalize() {
    return new Promise((resolve, reject) => {
      this.output.on("end", resolve);
      this.output.on("close", resolve);
      this.output.on("finish", resolve);
      this.output.on("error", reject);
      this.archive.finalize();
    });
  }
}

function ignoreMissing(dependency, optional) {
  return alwaysIgnored.has(dependency) || (optional && dependency in optional);
}

function getDependencies(filename, basedir) {
  const servicePath = basedir;

  const filePaths = new Set();
  const modulePaths = new Set();

  const modulesToProcess = [];
  const localFilesToProcess = [filename];

  function handle(name, basedir, optionalDependencies) {
    const moduleName = requirePackageName(name.replace(/\\/, "/"));

    if (alwaysIgnored.has(moduleName)) {
      return;
    }

    try {
      const pathToModule = resolve.sync(path.join(moduleName, "package.json"), {
        basedir
      });
      const pkg = readPkgUp.sync({ cwd: pathToModule });

      if (pkg) {
        modulesToProcess.push(pkg);
      }
    } catch (e) {
      if (e.code === "MODULE_NOT_FOUND") {
        if (ignoreMissing(moduleName, optionalDependencies)) {
          serverless.cli.log(
            `WARNING missing optional dependency: ${moduleName}`
          );
          return null;
        }
        try {
          // this resolves the requested import also against any set up NODE_PATH extensions, etc.
          const resolved = require.resolve(name);
          localFilesToProcess.push(resolved);
          return;
        } catch (e) {
          throw new Error(`Could not find ${moduleName}`);
        }
      }
      throw e;
    }
  }

  while (localFilesToProcess.length) {
    const currentLocalFile = localFilesToProcess.pop();

    if (filePaths.has(currentLocalFile)) {
      continue;
    }

    filePaths.add(currentLocalFile);
    precinct
      .paperwork(currentLocalFile, { includeCore: false })
      .forEach(dependency => {
        if (dependency.indexOf(".") === 0) {
          const abs = resolve.sync(dependency, {
            basedir: path.dirname(currentLocalFile)
          });
          localFilesToProcess.push(abs);
        } else {
          handle(dependency, servicePath);
        }
      });
  }

  while (modulesToProcess.length) {
    const currentModule = modulesToProcess.pop();
    const currentModulePath = path.join(currentModule.path, "..");

    if (modulePaths.has(currentModulePath)) {
      continue;
    }

    modulePaths.add(currentModulePath);

    const packageJson = currentModule.pkg;

    ["dependencies", "peerDependencies", "optionalDependencies"].forEach(
      key => {
        const dependencies = packageJson[key];

        if (dependencies) {
          Object.keys(dependencies).forEach(dependency => {
            handle(
              dependency,
              currentModulePath,
              packageJson.optionalDependencies
            );
          });
        }
      }
    );
  }

  modulePaths.forEach(modulePath => {
    const moduleFilePaths = glob.sync(path.join(modulePath, "**"), {
      nodir: true,
      ignore: path.join(modulePath, "node_modules", "**"),
      absolute: true
    });

    moduleFilePaths.forEach(moduleFilePath => {
      filePaths.add(moduleFilePath);
    });
  });

  return Array.from(filePaths);
}

function findModuleDir(dir) {
  let basedir = dir;
  while (!fs.existsSync(path.join(basedir, "package.json"))) {
    const newBasedir = path.dirname(basedir);
    if (newBasedir === basedir) {
      return null;
    }
    basedir = newBasedir;
  }
  return basedir;
}

function filesForFunctionZip(functionPath) {
  const filesToBundle = new Set();
  if (fs.lstatSync(functionPath).isDirectory()) {
    const moduledir = findModuleDir(functionPath);
    glob
      .sync(path.join(functionPath, "**"), {
        nodir: true,
        ignore: path.join(moduledir, "node_modules", "**"),
        absolute: true
      })
      .forEach(file => filesToBundle.add(file));
    if (moduledir) {
      let handler = null;
      const namedHandler = path.join(
        functionPath,
        `${path.basename(functionPath)}.js`
      );
      const indexHandler = path.join(functionPath, "index.js");
      if (fs.existsSync(namedHandler)) {
        handler = namedHandler;
      } else if (fs.existsSync(indexHandler)) {
        handler = indexHandler;
      } else {
        throw ("Failed to find handler for ", functionPath);
      }

      getDependencies(handler, moduledir).forEach(file =>
        filesToBundle.add(file)
      );
    }
  } else {
    filesToBundle.add(functionPath);
    const moduledir = findModuleDir(path.dirname(functionPath));
    if (moduledir) {
      getDependencies(functionPath, moduledir).forEach(file =>
        filesToBundle.add(file)
      );
    }
  }
  return filesToBundle;
}

function isGoExe(file) {
  try {
    const buf = fs.readFileSync(file);
    const elf = elfTools.parse(buf);
    return elf.sections.find(s => s.header.name === ".note.go.buildid");
  } catch (e) {
    return false;
  }
}

function zipEntryPath(file, basedir, moduledir) {
  return file
    .replace(basedir, "")
    .replace(moduledir, "")
    .replace(/^\//, "");
}

function zipGoExe(file, zipPath) {
  const zip = new Zip(zipPath);
  const stat = fs.lstatSync(file);
  zip.addLocalFile(file, {
    name: path.basename(file),
    mode: stat.mode,
    date: stat.mtime,
    stats: stat
  });
  return zip.finalize();
}

function zipJs(functionPath, zipPath) {
  const zip = new Zip(zipPath);
  let basedir = functionPath;
  if (fs.lstatSync(functionPath).isFile()) {
    basedir = path.dirname(basedir);
  }
  const moduledir = findModuleDir(basedir);

  filesForFunctionZip(functionPath).forEach(file => {
    const entryPath = zipEntryPath(file, basedir, moduledir);
    const stat = fs.lstatSync(file);
    zip.addLocalFile(file, {
      name: entryPath,
      mode: stat.mode,
      date: stat.mtime,
      stats: stat
    });
  });
  return zip.finalize();
}

function zipFunction(functionPath, destFolder) {
  if (path.basename(functionPath) === "node_modules") {
    return Promise.resolve(null);
  }
  const zipPath = path.join(
    destFolder,
    path.basename(functionPath).replace(/\.(js|zip)$/, "") + ".zip"
  );
  if (path.extname(functionPath) === ".zip") {
    fs.copyFileSync(functionPath, zipPath);
    return Promise.resolve({
      path: zipPath,
      runtime: "js"
    });
  }
  const ds = fs.lstatSync(functionPath);
  if (ds.isDirectory() || path.extname(functionPath) === ".js") {
    return zipJs(functionPath, zipPath).then(() => {
      return {
        path: zipPath,
        runtime: "js"
      };
    });
  }
  if (isGoExe(functionPath)) {
    return zipGoExe(functionPath, zipPath).then(() => {
      return {
        path: zipPath,
        runtime: "go"
      };
    });
  }
  return Promise.resolve(null);
}

function zipFunctions(srcFolder, destFolder, cb) {
  return Promise.all(
    fs
      .readdirSync(srcFolder)
      .map(file =>
        zipFunction(path.resolve(path.join(srcFolder, file)), destFolder)
      )
  );
}

module.exports = {
  getDependencies,
  filesForFunctionZip,
  zipFunction,
  zipFunctions
};
