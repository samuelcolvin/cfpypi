addEventListener('fetch', e => e.respondWith(handle(e.request)))

async function handle(request) {
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
      return await download(request, url)
    }
    return new Response('403: password for downloading wrong\n', { status: 403 })
  } else if (credentials.user === UPLOAD_USER) {
    if (credentials.password === UPLOAD_PASSWORD) {
      if (request.method === 'GET') {
        return await download(request, url)
      } else {
        return await upload(request, url)
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

  const filename = get_filename(url)

  if (url.searchParams.get('list')) {
    /// assume filename IS the package name
    const package_lookup = filename.replace('-', '_').toLowerCase()
    const existing_versions = await get_versions(package_lookup)
    const data = { package: package_lookup, versions: existing_versions }
    return new Response(JSON.stringify(data, null, 2) + '\n', { headers: { 'content-type': 'application/json' } })
  }

  let package_info
  try {
    package_info = get_package_info(filename, true)
  } catch (e) {
    return new Response(`400: ${e.toString()}\n`, { status: 400 })
  }
  const package_name = package_info.name
  const extra = package_info.extra

  if (!package_info.version) {
    const existing_versions = await get_versions(package_name)
    package_info.version = existing_versions.filter(v => v.extra === extra).map(v => v.version)[0]
    if (!package_info.version) {
      return new Response(`404: no versions found for package "${package_name}-*${extra}"\n`, { status: 404 })
    }
  }
  const headers = {
    'package-name': package_name,
    'package-version': package_info.version,
    'package-extra': package_info.extra,
  }
  const data = await PACKAGES.get(package_key(package_info), 'stream')
  if (!data) {
    return new Response(`404: file ${canonical_filename(package_info)} not found\n`, { status: 404, headers })
  }
  return new Response(data, { headers })
}

async function upload(request, url) {
  const r = check_method(request, 'POST')
  if (r) {
    return r
  }

  const filename = get_filename(url)
  let package_info
  try {
    package_info = get_package_info(filename)
  } catch (e) {
    return new Response(`400: ${e.toString()}\n`, { status: 400 })
  }
  const { version, extra } = package_info

  const key = package_key(package_info)
  const exists = await PACKAGES.get(key)
  if (exists) {
    return new Response(`409: file "${canonical_filename(package_info)}" already exists\n`, { status: 409 })
  }
  await PACKAGES.put(key, request.body, { metadata: { version, extra } })
  return new Response(`uploaded package "${canonical_filename(package_info)}" successfully!\n`, { status: 201 })
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

const get_filename = url => url.pathname.substr(1).replace(/\/+$/, '')

// dashes are allowed tar package names but not wheel where they get replaced with underscore
const tar_pattern = /^([^:]+)-([^:-]+)(\.tar\.gz)$/i
const wheel_pattern = /^([^:-]+?)-([^:-]+)(-.+?-.+?-.+?\.whl)$/i

function get_package_info(filename, allow_latest = false) {
  const match = filename.match(tar_pattern) || filename.match(wheel_pattern)
  if (!match) {
    throw new Error(`invalid filename "${filename}", should be a valid .whl or .tar.gz filename`)
  }

  let version
  if (allow_latest && match[2].toLowerCase() === 'latest') {
    version = null
  } else {
    version = parse_version(match[2]).canonical
  }
  return { name: match[1].replace('-', '_').toLowerCase(), version, extra: match[3].toLowerCase() }
}

const package_key = pi => `${pi.name}:${pi.version}:${pi.extra}`
const canonical_filename = pi => `${pi.name}-${pi.version}${pi.extra}`

const version_pattern = /^v?(\d+)\.(\d+)(?:\.(\d+)(?:([ab])(\d+))?)?$/i
const parse_version = version => {
  const match = version.match(version_pattern)
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
  rv.canonical = `${rv.major}.${rv.minor}.${rv.patch}`
  rv.magnitude = rv.major * 1e9 + rv.minor * 1e6 + rv.patch * 1e3
  if (rv.PreReleaseLabel) {
    rv.canonical += `${rv.PreReleaseLabel}${rv.PreRelease}`
    rv.magnitude -= rv.PreReleaseLabel === 'a' ? 200 : 100
    rv.magnitude += rv.PreRelease
  }
  return rv
}

async function get_versions(package_name) {
  const list = await PACKAGES.list({ prefix: `${package_name}:` })
  return list.keys
    .map(v => ({ version: parse_version(v.metadata.version), extra: v.metadata.extra }))
    .sort((a, b) => b.version.magnitude - a.version.magnitude)
    .map(v => {
      const d = { version: v.version.canonical, extra: v.extra }
      return {
        name: canonical_filename({ name: package_name, ...d }),
        ...d,
      }
    })
}
