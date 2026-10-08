// Retry-list repro, run with: node supabase/outbox-retry.test.mjs
//
// Before the fix, remapCarId swapped a car's local id for the server id
// while that same object was still on accountOutbox.inserts. The filter
// then looked for the old id and missed it. After a reload the saved car
// stayed on the retry list, flushOutbox treated it as a failed insert,
// the garage showed "Not saved yet - check your connection", and queued
// checklist taps were never sent.
//
// This loads the functions from index.html and runs that sequence.

import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const html = readFileSync(join(root, 'index.html'), 'utf8')
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'))

function extractFunction(name) {
  const needle = 'function ' + name + '('
  const start = script.indexOf(needle)
  if (start < 0) throw new Error('missing ' + name)
  let i = script.indexOf('{', start)
  let depth = 0
  for (; i < script.length; i++) {
    const ch = script[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return script.slice(start, i + 1)
    }
  }
  throw new Error('unclosed ' + name)
}

const names = [
  'toCarInsert',
  'fromCarRow',
  'fromInspRow',
  'outboxPending',
  'showSaveWarning',
  'hideSaveWarning',
  'persistOutbox',
  'remapCarId',
  'pushInspection',
  'pushCarInsert',
  'flushOutbox',
  'deleteCarOnServer',
]

const SERVER = '11111111-1111-4111-8111-111111111111'
const store = new Map()
const warn = { hidden: true }
const upserts = []
const inserts = []

function memoryStorage() {
  return {
    getItem(key) { return store.has(key) ? store.get(key) : null },
    setItem(key, value) { store.set(key, String(value)) },
    removeItem(key) { store.delete(key) },
  }
}

function serverRow(id) {
  return {
    id,
    year: 2002,
    model: 'Carrera',
    trans: '6MT',
    color: null,
    mileage: null,
    vin: null,
    status: 'shopping',
    notes: null,
    added_at: '2026-10-08T00:00:00.000Z',
    rare_spec_ids: [],
    imported_from_demo_id: null,
  }
}

function inspectionPayload(answers) {
  return {
    answers: answers || { A1: 'done' },
    done: 1,
    flags: 0,
    total: 48,
    verdict: 'Inspecting',
    verdictClass: 'vc-pending',
    pct: 2,
    weighted_pct: 2,
    tier1_walk: false,
    chassis_key: 'carrera2',
    trans_key: 'mt',
    savedAt: '2026-10-08T00:00:00.000Z',
  }
}

function makeClient() {
  return {
    from(table) {
      return {
        insert(row) {
          inserts.push({ table, row })
          return {
            select() {
              return {
                single() {
                  return Promise.resolve({ data: serverRow(SERVER), error: null })
                },
              }
            },
          }
        },
        upsert(row) {
          upserts.push({ table, row })
          return {
            select() {
              return {
                single() {
                  return Promise.resolve({
                    data: {
                      id: 'insp-1',
                      car_id: row.car_id,
                      saved_at: row.saved_at,
                      done: row.done,
                      flags: row.flags,
                      total: row.total,
                      verdict: row.verdict,
                      verdict_class: row.verdict_class,
                    },
                    error: null,
                  })
                },
              }
            },
          }
        },
        update() {
          return { eq() { return Promise.resolve({ error: null }) } }
        },
        delete() {
          return { eq() { return Promise.resolve({ error: null }) } }
        },
      }
    },
  }
}

function boot() {
  store.clear()
  upserts.length = 0
  inserts.length = 0
  warn.hidden = true
  const sandbox = {
    accountOutbox: { inserts: [], inspections: {}, rares: {}, deletes: [], profile: null },
    accountCache: { cars: [], inspections: [], answers: {}, meta: {}, profile: null },
    accountMode: true,
    accountUserId: 'user-1',
    sbClient: makeClient(),
    carInsertJobs: {},
    OUTBOX_KEY: 'da-996-account-outbox-v1',
    localStorage: memoryStorage(),
    document: {
      getElementById(id) {
        if (id === 'save-warn') return warn
        return {
          hidden: true,
          classList: { add() {}, remove() {}, contains() { return false } },
          textContent: '',
        }
      },
    },
    renderGarage() {},
    refreshCarSelect() {},
    renderInspectionsList() {},
    flashSaved() {},
    console,
    Promise,
    Date,
    Object,
    String,
    JSON,
  }
  vm.createContext(sandbox)
  vm.runInContext(names.map(extractFunction).join('\n'), sandbox)
  return sandbox
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const savedFirst = boot()
{
  const pending = 'pending-reload'
  const car = {
    id: pending,
    year: '2002',
    model: 'Carrera',
    trans: '6MT',
    color: '',
    mileage: '',
    vin: '',
    status: 'shopping',
    notes: '',
    rare_spec_ids: [],
    pending: true,
  }
  savedFirst.accountCache.cars.push(car)
  savedFirst.accountOutbox.inserts.push(car)
  savedFirst.accountOutbox.inspections[pending] = inspectionPayload()
  savedFirst.remapCarId(pending, serverRow(SERVER))
  assert(savedFirst.accountOutbox.inserts.length === 0, 'saved car stayed on the retry list')
  assert(car.id === SERVER, 'cache car did not receive the server id')
  assert(!savedFirst.accountOutbox.inspections[pending], 'inspection still keyed by the local id')
  assert(savedFirst.accountOutbox.inspections[SERVER].answers.A1 === 'done', 'inspection was not moved to the server id')
}

const staleReload = boot()
{
  const car = {
    id: SERVER,
    year: '2002',
    model: 'Carrera',
    trans: '6MT',
    color: '',
    mileage: '',
    vin: '',
    status: 'shopping',
    notes: '',
    rare_spec_ids: [],
    pending: false,
  }
  staleReload.accountCache.cars.push(car)
  staleReload.accountOutbox.inserts.push(car)
  staleReload.accountOutbox.inspections[SERVER] = inspectionPayload({ B2: 'flag' })
  staleReload.showSaveWarning()
  await staleReload.flushOutbox()
  assert(inserts.length === 0, 'retry inserted a car that was already saved')
  assert(staleReload.accountOutbox.inserts.length === 0, 'saved car was not dropped from the retry list')
  assert(upserts.length === 1 && upserts[0].row.car_id === SERVER, 'queued checklist tap was not re-sent')
  assert(upserts[0].row.answers.B2 === 'flag', 're-sent answers were not the queued ones')
  assert(!staleReload.accountOutbox.inspections[SERVER], 'inspection stayed queued after a successful send')
  assert(warn.hidden === true, 'Not saved yet stayed up after the retry list was clear')
}

const offlineThenSaved = boot()
{
  const pending = 'pending-offline'
  const car = {
    id: pending,
    year: '2002',
    model: 'Carrera',
    trans: '6MT',
    color: '',
    mileage: '',
    vin: '',
    status: 'shopping',
    notes: '',
    rare_spec_ids: [],
    pending: true,
  }
  offlineThenSaved.accountCache.cars.push(car)
  offlineThenSaved.accountOutbox.inserts.push(car)
  offlineThenSaved.accountOutbox.inspections[pending] = inspectionPayload({ A3: 'done' })
  const ok = await offlineThenSaved.pushCarInsert(car)
  assert(ok === true, 'pending insert did not succeed')
  assert(offlineThenSaved.accountOutbox.inserts.length === 0, 'pending car remained after the server id arrived')
  assert(upserts.length === 1 && upserts[0].row.car_id === SERVER, 'checklist tap was not sent after the car got a server id')
  assert(upserts[0].row.answers.A3 === 'done', 'sent checklist answers did not match the offline tap')
  assert(car.id === SERVER, 'local id was not swapped after the insert')
}

const CAR = '22222222-2222-4222-8222-222222222222'
function recordClient(ops, photos) {
  return {
    from(table) {
      return {
        select() {
          ops.push(table + '.select')
          return { eq() { return Promise.resolve({ data: photos, error: null }) } }
        },
        delete() {
          return {
            eq() {
              ops.push(table + '.delete')
              return Promise.resolve({ error: null })
            },
          }
        },
      }
    },
    storage: {
      from(bucket) {
        return {
          remove(paths) {
            ops.push('storage.remove:' + bucket + ':' + paths.join(','))
            return Promise.resolve({ error: null })
          },
        }
      },
    },
  }
}

const withPhotos = boot()
{
  const ops = []
  withPhotos.sbClient = recordClient(ops, [{ storage_path: 'user-1/' + CAR + '/a.jpg' }])
  const ok = await withPhotos.deleteCarOnServer(CAR)
  assert(ok === true, 'car delete did not finish')
  assert(ops.join(' > ') === [
    'photos.select',
    'storage.remove:car-photos:user-1/' + CAR + '/a.jpg',
    'photos.delete',
    'cars.delete',
  ].join(' > '), 'delete order was ' + ops.join(' > '))
}

const noPhotos = boot()
{
  const ops = []
  noPhotos.sbClient = recordClient(ops, [])
  const ok = await noPhotos.deleteCarOnServer(CAR)
  assert(ok === true, 'car delete without photos did not finish')
  assert(ops.join(' > ') === 'photos.select > cars.delete', 'empty photo delete order was ' + ops.join(' > '))
}

const fn = readFileSync(join(root, 'supabase/functions/delete-account/index.ts'), 'utf8')
{
  const files = fn.indexOf('await removeUserPhotos(admin, uid)')
  const rows = fn.indexOf("admin.from('photos').delete()")
  const user = fn.indexOf('admin.auth.admin.deleteUser(uid)')
  assert(files !== -1 && rows !== -1 && user !== -1, 'delete-account is missing a photo or user delete')
  assert(files < rows && rows < user, 'delete-account does not remove files and photo rows before the user')
}

console.log('outbox-retry.test.mjs: 5 cases passed')
