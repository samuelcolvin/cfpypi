addEventListener('fetch', e => e.respondWith(handle(e.request)))

function handle(request) {
  const url = new URL(request.url)
  if (url.pathname === '/') {
    return index(request, url)
  }
  const credentials = get_credentials(request)
  // const credentials = { user: DOWNLOAD_USER, password: DOWNLOAD_PASSWORD }
  if (!credentials) {
    return new Response('401: invalid "Authorization" header\n', {
      status: 401,
      headers: { 'WWW-Authenticate': ' Basic realm="Access to the cfpyi site"' },
    })
  }
  if (credentials.user === DOWNLOAD_USER) {
    if (credentials.password === DOWNLOAD_PASSWORD) {
      return download(request, url)
    }
    return new Response('403: password for downloading wrong\n', { status: 403 })
  } else if (credentials.user === UPLOAD_USER) {
    if (credentials.password === UPLOAD_PASSWORD) {
      if (request.method === 'GET') {
        return download(request, url)
      } else {
        return upload(request, url)
      }
    }
    return new Response('403: password for uploading wrong\n', { status: 403 })
  } else {
    return new Response('403: username wrong\n', { status: 403 })
  }
}

const index_html = `
<h1>cfpypi</h1>
<p>
  Private python package index using cloudflare workers
</p>
<p>
  See 
  <a href="https://github.com/samuelcolvin/cfpypi">github.com/samuelcolvin/cfpypi</a>
  for more details.
</p>
`

async function index(request, url) {
  const r = check_method(request, 'GET')
  if (r) {
    return r
  }
  return new Response(index_html, { headers: { 'content-type': 'text/html' } })
}

async function download(request, url) {
  const r = check_method(request, 'GET')
  if (r) {
    return r
  }

  let path_data
  try {
    path_data = get_package_version(url)
  } catch (e) {
    return new Response(`400: ${e.toString()}\n`, { status: 400 })
  }
  const package_name = path_data.package_name
  let version = path_data.version

  const existing_versions = await get_versions(package_name)
  if (!existing_versions.length) {
    return new Response(`404: package "${package_name}" not found\n`, { status: 404 })
  }

  if (url.searchParams.get('list')) {
    const data = { package: package_name, versions: existing_versions }
    return new Response(JSON.stringify(data, null, 2) + '\n', { headers: { 'content-type': 'application/json' } })
  }

  if (!version) {
    version = existing_versions[0]
  }

  const data = await PACKAGES.get(`${package_name}==${version}`, 'stream')
  if (!data) {
    return new Response(`404: version "${version}" of "${package_name}" not found\n`, { status: 404 })
  }
  return new Response(data, { headers: { 'package-version': version, 'package-name': package_name } })
}

async function upload(request, url) {
  const r = check_method(request, 'POST')
  if (r) {
    return r
  }
  let path_data
  try {
    path_data = get_package_version(url)
  } catch (e) {
    return new Response(`400: ${e.toString()}\n`, { status: 400 })
  }
  const { package_name, version } = path_data

  const key = `${package_name}==${version}`
  const exists = await PACKAGES.get(key)
  if (exists) {
    return new Response(`409: package "${package_name}" version ${version} already exists\n`, { status: 409 })
  }
  await PACKAGES.put(key, request.body, { metadata: { version } })
  return new Response(`uploaded package "${package_name}", version "${version}" successfully!\n`, { status: 201 })
}

// utilities

function get_credentials(request) {
  const auth_header = request.headers.get('Authorization')
  if (typeof auth_header !== 'string') {
    return null
  }

  const b64 = auth_header.match(/^ *basic +([a-z0-9._~+/-]+=*) *$/i)
  if (!b64) {
    return null
  }

  const user_password = atob(b64[1]).match(/^([^:]*):(.*)$/)

  if (!user_password) {
    return null
  }
  const user = user_password[1]
  const password = user_password[2]
  return { user, password }
}

function check_method(request, expected) {
  if (request.method !== expected) {
    return new Response(`405: wrong method, expected ${expected}\n`, { status: 405, headers: { Allow: expected } })
  }
}

function get_package_version(url, require_version = false) {
  const path = url.pathname.substr(1).replace(/\/+$/g, '')
  const parts = path.split('/')
  if (parts.length === 2) {
    return { package_name: clean_path(parts[0]), version: parse_version(parts[1]).canonical }
  } else if (parts.length === 1) {
    if (require_version) {
      throw new Error('version not set, use "<package>/<version>" to supply version')
    }
    return { package_name: clean_path(parts[0]), version: null }
  } else {
    throw new Error('wrong number of part chunks, should be "<package>" or "<package>/<version>"')
  }
}

const clean_path = p => p.replace('_', '-')

const pattern = /^v?(\d+)\.(\d+)(?:\.(\d+)(?:([ab])(\d+))?)?$/i
const parse_version = version => {
  const match = version.match(pattern)
  if (!match) {
    throw new Error(`invalid version "${version}"`)
  }

  const rv = {
    major: Number(match[1]),
    minor: 0,
    patch: 0,
  }
  if (match[2]) {
    rv.minor = Number(match[2])
    if (match[3]) {
      rv.patch = Number(match[3])
      if (match[4]) {
        rv.PreReleaseLabel = match[4]
        rv.PreRelease = Number(match[5])
      }
    }
  }
  rv.canonical = `v${rv.major}.${rv.minor}.${rv.patch}`
  rv.magnitude = rv.major * 1e9 + rv.minor * 1e6 + rv.patch * 1e3
  if (rv.PreReleaseLabel) {
    rv.canonical += `${rv.PreReleaseLabel}${rv.PreRelease}`
    rv.magnitude -= rv.PreReleaseLabel === 'a' ? 200 : 100
    rv.magnitude += rv.PreRelease
  }
  return rv
}

async function get_versions(package_name) {
  const list = await PACKAGES.list({ prefix: `${package_name}==` })
  return list.keys
    .map(v => parse_version(v.metadata.version))
    .sort((a, b) => b.magnitude - a.magnitude)
    .map(v => v.canonical)
}
