addEventListener('fetch', e => e.respondWith(handle(e.request)))

function handle(request) {
  const url = new URL(request.url)
  if (url.pathname === '/') {
    return index(request, url)
  }
  // const credentials = get_credentials(request)
  const credentials = {user: 'upload', password: UPLOAD_PASSWORD}
  if (!credentials) {
    return new Response('invalid "Authorization" header', {
      status: 401,
      headers: { 'WWW-Authenticate': ' Basic realm="Access to the cfpyi site"' },
    })
  }
  if (credentials.user === 'download') {
    if (credentials.password === DOWNLOAD_PASSWORD) {
      return download(request, url)
    }
    return new Response('password download wrong', { status: 403 })
  } else if (credentials.user === 'upload') {
    if (credentials.password === UPLOAD_PASSWORD) {
      return upload(request, url)
    }
    return new Response('password upload wrong', { status: 403 })
  } else {
    return new Response('username wrong', { status: 403 })
  }
}

async function index (request, url) {
  const r = check_method(request, 'GET')
  if (r) {
    return r
  }
  return new Response('cfpypi')
}

async function download(request, url) {
  const r = check_method(request, 'GET')
  if (r) {
    return r
  }
  const package_name = url.pathname.substr(1)
  return new Response(`downloaded`)
}

async function upload(request, url) {
  const r = check_method(request, 'POST')
  if (r) {
    return r
  }
  const package_name = url.pathname.substr(1)
  await PACKAGES.put(package_name, request.body)
  return new Response(`uploaded package "${package_name}"`)
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
    return new Response(`wrong method, expected ${expected}`, {status: 405, headers: {'Allow': expected}})
  }
}
