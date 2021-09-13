import { existsSync, createReadStream, statSync } from 'fs'
import { readFile, readdir } from 'fs/promises'
import { dirname, join, normalize, relative, resolve } from 'path'
import http from 'http'
import getPort from 'get-port'
import localAccess from 'local-access'
import mime from 'mime/lite.js'
import chokidar from 'chokidar'

const headPrependInjectRE = [/<head>/, /<!doctype html>/i]
function prependHead(html, code) {
  for (const re of headPrependInjectRE) {
    if (re.test(html)) {
      return html.replace(re, `$&\n${code}`)
    }
  }
  return code + '\n' + html
}

const ReloadScript = `
new EventSource('/__source').addEventListener('message', ({ data }) => {
  if (data === "reload") {
    location.reload();
  }
});
`

async function sendFile(req, res, file, { cors }) {
  const stats = statSync(file)
  if (stats.isDirectory()) {
    return listDirectory(req, res, file, { cors })
  }

  let headers = {
    'Content-Length': stats.size,
    'Content-Type': mime.getType(file) || '',
    'Cache-Control': 'no-store',
  }
  if (cors) {
    headers['Access-Control-Allow-Origin'] = '*'
    headers['Access-Control-Allow-Headers'] = 'Origin, Content-Type, Accept, Range'
  }

  let code = 200
  let opts = {}
  if (req.headers.range) {
    code = 206
    let [x, y] = req.headers.range.replace('bytes=', '').split('-')
    let end = (opts.end = parseInt(y, 10) || stats.size - 1)
    let start = (opts.start = parseInt(x, 10) || 0)

    if (start >= stats.size || end >= stats.size) {
      res.setHeader('Content-Range', `bytes */${stats.size}`)
      res.statusCode = 416
      return res.end()
    }

    headers['Content-Range'] = `bytes ${start}-${end}/${stats.size}`
    headers['Content-Length'] = end - start + 1
    headers['Accept-Ranges'] = 'bytes'
  }

  if (file.endsWith('.html')) {
    let html = await readFile(file, 'utf-8')
    html = prependHead(html, `<script>${ReloadScript}</script>`)
    headers['Content-Length'] = html.length
    res.writeHead(code, headers)
    res.end(html)
  } else {
    res.writeHead(code, headers)
    createReadStream(file, opts).pipe(res)
  }
}

function sendHTML(req, res, code, { cors }) {
  code = prependHead(code, `<script>${ReloadScript}</script>`)
  let headers = {
    'Content-Length': code.length,
    'Content-Type': 'text/html',
    'Cache-Control': 'no-store',
  }
  if (cors) {
    headers['Access-Control-Allow-Origin'] = '*'
    headers['Access-Control-Allow-Headers'] = 'Origin, Content-Type, Accept, Range'
  }
  res.writeHead(200, headers)
  res.end(code)
}

const DirectoryTemplate = `
<!DOCTYPE html>
<html><head>
<title>Index of {dir}</title>
<meta charset="utf-8"></head><body>
<table id="table"></table>
<template id="row">
  <tr><td><a href=""></a></td></tr>
</template>
<script>
let $template = document.querySelector('#row')
let $table = document.querySelector('#table')
let files={files};
for (let file of files) {
  let tr = $template.content.cloneNode(true)
  let a = tr.querySelector('a')
  a.textContent = file
  a.href = file
  $table.append(tr)
}
</script>
`

async function listDirectory(req, res, dir, { cors }) {
  let files = await readdir(dir, { encoding: 'utf-8', withFileTypes: true })
  let data = {
    dir: relative(process.cwd(), dir) || '.',
    files: JSON.stringify(files.map(file => (file.isDirectory() ? file.name + '/' : file.name))),
  }
  let html = DirectoryTemplate.replace(/{(\w+)}/g, (_, key) => data[key] || '')
  sendHTML(req, res, html, { cors })
}

const ErrorTemplate = `
<!DOCTYPE html>
<html><head>
<title>Error</title>
<meta charset="utf-8"></head><body>
<pre>{message}
{stack}</pre>
`

function error(req, res, err, { cors }) {
  let html = ErrorTemplate.replace(/{(\w+)}/g, (_, key) => err[key] || '')
  sendHTML(req, res, html, { cors })
}

export default async function serve(entry, opts = {}) {
  entry = resolve(entry || '.')
  let entryIsFile = statSync(entry).isFile()
  let dir = entryIsFile ? dirname(entry) : entry
  let clients = new Set()
  let watcher = chokidar.watch(entry, {
    ignored: ['**/node_modules/**', '**/.git/**'],
    ignoreInitial: true,
    ignorePermissionErrors: true,
    disableGlobbing: true,
  })
  watcher.on('change', () => {
    clients.forEach(client => client.write('data: reload\n\n'))
  })

  let server = http.createServer((req, res) => {
    let pathname = req.url
    if (!pathname) pathname = '/'

    let idx
    if (!~(idx = pathname.indexOf('?', 1))) {
      pathname = pathname.substring(idx)
    }

    if (!~pathname.indexOf('%')) {
      try {
        pathname = decodeURIComponent(pathname)
      } catch (err) {}
    }

    if (pathname === '/__source') {
      let headers = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      }
      if (opts.cors) {
        headers['Access-Control-Allow-Origin'] = '*'
        headers['Access-Control-Allow-Headers'] = 'Origin, Content-Type, Accept, Range'
      }
      clients.add(res)
      res.writeHead(200, headers)
      res.write(': connected')
      return
    }

    let filename = pathname
    let tryIndex = false
    if (filename === '/' && entryIsFile) {
      filename = entry
    }
    if (filename.endsWith('/')) {
      filename += 'index.html'
      tryIndex = true
    }
    filename = normalize(join(dir, filename))

    if (existsSync(filename)) {
      sendFile(req, res, filename, opts).catch(err => {
        error(req, res, err, opts)
      })
    } else if (tryIndex) {
      listDirectory(req, res, dirname(filename), opts).catch(err => {
        error(req, res, err, opts)
      })
    } else {
      res.statusCode = 404
      res.end()
    }
  })

  if (opts.logs && !opts.quiet) {
    const { hrtime } = process
    let url, dur, start
    let first = true
    server.on('request', (req, res) => {
      start = hrtime()
      req.once('end', _ => {
        dur = hrtime(start)
        url = req.originalUrl || req.url
        if (first) {
          first = false
          console.log()
        }
        console.log(`${res.statusCode} - ${(dur[1] / 1e6).toFixed(2)}ms - ${req.method} ${url}`)
      })
    })
  }

  const { HOST, PORT } = process.env
  let hostname = HOST || opts.host || 'localhost'
  let port = await getPort({ host: hostname, port: PORT || opts.port })
  server.listen(port, hostname, err => {
    if (err) throw err
    if (opts.quiet) return
    let { local, network } = localAccess({ port, hostname })
    console.log(`serving ${local}`)
    if (!hostname.includes('localhost')) {
      console.log(`serving ${network}`)
    }
  })

  return server
}
