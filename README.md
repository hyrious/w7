## @hyrious/w7

Serve a folder / file, with auto reload.

### Usage

```bash
npm i -g @hyrious/w7
w7 --help

  Description
    Serve the pure html, update the browser on change.

  Usage
    $ w7 [entry] [options]

  Options
    -c, --cors       Enable "CORS" headers
    -s, --single     Serve as single-page application
    -q, --quiet      Disable logging to terminal
    -H, --host       Hostname to bind  (default localhost)
    -p, --port       Port to bind  (default 5000)
    -v, --version    Displays current version
    -h, --help       Displays this message

  Examples
    $ w7
    $ w7 index.html
    $ w7 dist
    $ w7 app.html --port 4000
    $ w7 --cors --quiet --open
```

### Alternatives

- [w7](https://github.com/ulivz/w7)
- [sirv](https://github.com/lukeed/sirv)
- [vite](https://vitejs.dev)

### License

The MIT License.
