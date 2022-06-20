#!/usr/bin/env node
import sade from 'sade'
import version from './version.cjs'
import serve from './index.js'

sade('w7 [entry]')
  .version(version)
  .describe('Serve the pure html, update the browser on change.')
  .example('')
  .example('index.html')
  .example('dist')
  .example('app.html --port 4000')
  .example('--cors --quiet --open')
  .option('-c, --cors', 'Enable "CORS" headers')
  .option('-s, --single', 'Serve as single-page application')
  .option('-P, --preview', 'Disable hot-reload')
  .option('-q, --quiet', 'Disable logging to terminal')
  .option('-H, --host', 'Hostname to bind', 'localhost')
  .option('-p, --port', 'Port to bind', 5000)
  .action(serve)
  .parse(process.argv, {
    default: {
      quiet: false,
      cors: false,
      logs: true,
    },
  })
