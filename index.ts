import chokidar from 'chokidar'
import debounceFn from 'debounce-fn'
import { createReadStream, existsSync, statSync } from 'fs'
import { readdir, readFile } from 'fs/promises'
import getPort from 'get-port'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import localAccess from 'local-access'
import mime from 'mime/lite.js'
import { basename, dirname, join, normalize, relative, resolve } from 'path'

export interface Options {
  cors?: boolean
  quiet?: boolean
  logs?: boolean
  host?: string
  port?: number
  single?: boolean | string
}

function notFound(req: IncomingMessage, res: ServerResponse) {
  res.statusCode = 404
  res.end()
}

export default async function serve(entry: string, opts: Options = {}) {
  entry = resolve(entry || '.')
  let entryIsFile = statSync(entry).isFile()
  let dir = entryIsFile ? dirname(entry) : entry
  let clients = new Set<ServerResponse>()
  let watcher = chokidar.watch(entry, {
    ignored: ['**/node_modules/**', '**/.git/**'],
    ignoreInitial: true,
    ignorePermissionErrors: true,
    disableGlobbing: true,
  })
  watcher.on(
    'change',
    debounceFn(
      () => {
        clients.forEach(client => client.write('data: reload\n\n'))
      },
      { wait: 100 }
    )
  )

  let server = createServer(async (req, res) => {
    let pathname = req.url || '/'

    let idx
    if (~(idx = pathname.indexOf('?', 1))) {
      pathname = pathname.substring(0, idx)
    }

    if (pathname.includes('%')) {
      try {
        pathname = decodeURIComponent(pathname)
      } catch {}
    }

    if (opts.cors) {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Headers', 'Origin, Content-Type, Accept, Range')
    }

    if (pathname === '/__source') {
      return clientJoin(clients, res, opts)
    }

    let { filename, tryIndex } = resolveFilename(pathname, entryIsFile, entry, dir)

    try {
      if (existsSync(filename)) {
        await sendFile(req, res, filename)
      } else if (opts.single) {
        if (typeof opts.single === 'string') {
          filename = opts.single
        } else if (entryIsFile) {
          filename = entry
        } else {
          filename = 'index.html'
        }
        if (existsSync(filename)) {
          await sendFile(req, res, filename)
        } else {
          notFound(req, res)
        }
      } else if (tryIndex) {
        await listDir(req, res, dirname(filename))
      } else {
        notFound(req, res)
      }
    } catch (err) {
      sendError(req, res, err)
    }
  })

  if (opts.logs && !opts.quiet) {
    const { hrtime } = process
    let url: string, dur: [number, number], start: [number, number]
    server.on('request', (req, res) => {
      start = hrtime()
      req.once('end', () => {
        dur = hrtime(start)
        url = req.url || '/'
        console.log(`${res.statusCode} - ${(dur[1] / 1e6).toFixed(2)}ms - ${req.method} ${url}`)
      })
    })
  }

  const { HOST, PORT } = process.env
  let hostname = HOST || opts.host || 'localhost'
  let initialPort = PORT ? +PORT : opts.port || []
  let port = await getPort({ host: hostname, port: initialPort })
  server.listen(port, hostname, () => {
    if (opts.quiet) return
    let { local, network } = localAccess({ port, hostname })
    console.log(`serving ${local}`)
    if (!hostname.includes('localhost')) {
      console.log(`serving ${network}`)
    }
  })

  return server
}

function resolveFilename(pathname: string, entryIsFile: boolean, entry: string, dir: string) {
  let filename = pathname
  if (filename === '/' && entryIsFile) {
    filename = basename(entry)
  }
  let tryIndex = false
  if (filename.endsWith('/')) {
    filename += 'index.html'
    tryIndex = true
  }
  filename = normalize(join(dir, filename))
  return { filename, tryIndex }
}

async function sendFile(req: IncomingMessage, res: ServerResponse, file: string) {
  const stats = statSync(file)
  if (stats.isDirectory()) {
    return listDir(req, res, file)
  }

  let headers: Record<string, string | number> = {
    'Content-Length': stats.size,
    'Content-Type': mime.getType(file) || '',
    'Cache-Control': 'no-store',
  }
  let code = 200
  let opts: { start?: number; end?: number } = {}
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
    sendHTML(req, res, html)
  } else {
    res.writeHead(code, headers)
    createReadStream(file, opts).pipe(res)
  }
}

const DirectoryTemplate = `<!DOCTYPE html>
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

async function listDir(req: IncomingMessage, res: ServerResponse, dir: string) {
  let files = await readdir(dir, { encoding: 'utf-8', withFileTypes: true })
  let data: Record<string, string> = {
    dir: relative(process.cwd(), dir) || '.',
    files: JSON.stringify(files.map(file => (file.isDirectory() ? file.name + '/' : file.name))),
  }
  let html = DirectoryTemplate.replace(/{(\w+)}/g, (_, key) => data[key] || '')
  sendHTML(req, res, html)
}

const ErrorTemplate = `<!DOCTYPE html>
<html><head>
<title>Error</title>
<meta charset="utf-8"></head><body>
<pre>{message}
{stack}</pre>
`

function sendError(req: IncomingMessage, res: ServerResponse, err: unknown) {
  let html = ErrorTemplate.replace(/{(\w+)}/g, (_, key) => (err as any)[key] || '')
  sendHTML(req, res, html)
}

const headPrependInjectRE = [/<head>/, /<!doctype html>/i]

function prependHead(html: string, code: string) {
  for (const re of headPrependInjectRE) {
    if (re.test(html)) {
      return html.replace(re, `$&\n${code}`)
    }
  }
  return code + '\n' + html
}

const ReloadScript = `<script>
new EventSource('/__source').addEventListener('message', ({ data }) => {
  if (data === "reload") {
    location.reload();
  }
});
</script>`

function sendHTML(req: IncomingMessage, res: ServerResponse, html: string) {
  html = prependHead(html, ReloadScript)
  res.writeHead(200, {
    'Content-Length': Buffer.byteLength(html),
    'Content-Type': 'text/html',
    'Cache-Control': 'no-store',
  })
  res.end(html)
}

function clientJoin(clients: Set<ServerResponse>, res: ServerResponse, opts: Options) {
  clients.add(res)
  res.once('close', () => clients.delete(res))
  let headers: Record<string, string | number> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  }
  res.writeHead(200, headers)
  res.write(': connected\n\n')
  return
}
