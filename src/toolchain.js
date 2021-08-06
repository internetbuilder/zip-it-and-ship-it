const { addZipContent } = require('./archive')

const addToolchainFile = ({ archive, runtime }) => {
  const payload = { runtime: runtime.name }

  addZipContent(archive, JSON.stringify(payload), 'netlify-toolchain')
}

module.exports = { addToolchainFile }
