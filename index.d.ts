import http from 'http'

export default function serve(
  entry?: string,
  opts?: {
    cors?: boolean
    logs?: boolean
    quiet?: boolean
    host?: string
    port?: number
  }
): http.Server
