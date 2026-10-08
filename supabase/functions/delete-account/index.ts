// Delete the signed-in user's account.
// Verifies the caller from the Authorization JWT. Never reads a user id from the body.
// SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY are injected by
// Supabase at runtime. Do not write those secrets into the repo.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.3'

const ALLOWED_ORIGINS = [
  'https://996buyersguide.com',
  'http://localhost:8000',
]

function corsHeaders(origin: string | null): Headers | null {
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return null
  return new Headers({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  })
}

function json(body: unknown, status: number, cors: Headers | null): Response {
  const headers = cors ? new Headers(cors) : new Headers()
  headers.set('Content-Type', 'application/json')
  return new Response(JSON.stringify(body), { status, headers })
}

async function removeUserPhotos(admin: ReturnType<typeof createClient>, uid: string) {
  async function walk(prefix: string) {
    for (;;) {
      const { data, error } = await admin.storage.from('car-photos').list(prefix, {
        limit: 100,
        offset: 0,
      })
      if (error) throw error
      if (!data || data.length === 0) return

      const files: string[] = []
      const folders: string[] = []
      for (const item of data) {
        const path = `${prefix}/${item.name}`
        if (item.id == null) folders.push(path)
        else files.push(path)
      }
      for (const folder of folders) await walk(folder)
      if (files.length > 0) {
        const { error: removeError } = await admin.storage.from('car-photos').remove(files)
        if (removeError) throw removeError
      } else if (folders.length === 0) {
        return
      }
      if (files.length === 0) return
    }
  }
  await walk(uid)
}

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin')
  const cors = corsHeaders(origin)

  if (req.method === 'OPTIONS') {
    if (!cors) return new Response(null, { status: 403 })
    return new Response(null, { status: 204, headers: cors })
  }

  if (!cors) return json({ ok: false, error: 'origin' }, 403, null)
  if (req.method !== 'POST') return json({ ok: false, error: 'method' }, 405, cors)

  const header = req.headers.get('Authorization') || ''
  const jwt = header.replace(/^Bearer\s+/i, '').trim()
  if (!jwt) return json({ ok: false, error: 'unauthorized' }, 401, cors)

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json({ ok: false, error: 'server' }, 500, cors)
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: userData, error: userError } = await userClient.auth.getUser(jwt)
  if (userError || !userData.user) {
    return json({ ok: false, error: 'unauthorized' }, 401, cors)
  }
  const uid = userData.user.id

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  try {
    await removeUserPhotos(admin, uid)
    const { error: deleteError } = await admin.auth.admin.deleteUser(uid)
    if (deleteError) {
      return json({ ok: false, error: 'delete' }, 500, cors)
    }
  } catch (_err) {
    return json({ ok: false, error: 'delete' }, 500, cors)
  }

  return json({ ok: true }, 200, cors)
})
