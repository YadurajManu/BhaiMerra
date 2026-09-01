/**
 * Reading a .env into the secret store.
 *
 * These values become live credentials, so the parser's job is not to be
 * clever — it is to never hand back something subtly different from what is
 * written in the file. A password truncated at a '#', or with a stray quote
 * still attached, fails authentication somewhere with nothing pointing back
 * here. Every ambiguous case is reported instead of guessed.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseDotenv } from '../src/dotenv.js'
import { declaredSecrets } from '../src/plan.js'

const valueOf = (source: string, key: string) =>
  parseDotenv(source).entries.find((e) => e.key === key)?.value

describe('parsing a .env', () => {
  test('reads plain assignments, ignoring blanks and comments', () => {
    const { entries } = parseDotenv(
      ['# a comment', '', 'DB_PASSWORD=hunter2', '  JWT_SECRET=abc  ', ''].join('\n')
    )
    assert.deepEqual(
      entries.map((e) => [e.key, e.value]),
      [
        ['DB_PASSWORD', 'hunter2'],
        ['JWT_SECRET', 'abc'],
      ]
    )
  })

  test('accepts the shell-sourceable "export" form', () => {
    assert.equal(valueOf('export API_KEY=k123', 'API_KEY'), 'k123')
  })

  test('single quotes are literal', () => {
    // A password full of $ and \ is exactly why people quote it.
    assert.equal(valueOf(String.raw`PW='p$a\ss#word'`, 'PW'), String.raw`p$a\ss#word`)
  })

  test('double quotes take escapes, so a value can hold a newline', () => {
    assert.equal(valueOf(String.raw`KEY="line1\nline2"`, 'KEY'), 'line1\nline2')
    assert.equal(valueOf(String.raw`KEY="say \"hi\""`, 'KEY'), 'say "hi"')
  })

  test('an unquoted value keeps its "#" rather than being truncated', () => {
    // The common convention treats " #" as a comment. For a credential store
    // that silently shortens a password, so the whole value is kept and the
    // ambiguity is reported instead.
    const parsed = parseDotenv('PW=abc #123')
    assert.equal(parsed.entries[0]!.value, 'abc #123')
    assert.equal(parsed.warnings.length, 1)
    assert.match(parsed.warnings[0]!, /PW/)
    assert.match(parsed.warnings[0]!, /Quote the value/)
  })

  test('a "#" with no space before it is just part of the value', () => {
    assert.equal(valueOf('PW=abc#123', 'PW'), 'abc#123')
    assert.equal(parseDotenv('PW=abc#123').warnings.length, 0)
  })

  test('an unterminated quote is skipped, not guessed at', () => {
    const parsed = parseDotenv('KEY="never closed')
    assert.equal(parsed.entries.length, 0)
    assert.equal(parsed.skipped[0]!.reason, 'unterminated double quote')
  })

  test('a value containing "=" survives intact', () => {
    // Base64 pads with '=', and splitting on the last one would corrupt it.
    assert.equal(valueOf('JWT_SECRET=aGVsbG8=', 'JWT_SECRET'), 'aGVsbG8=')
    assert.equal(valueOf('URL=postgres://u:p@h:5432/db?x=1', 'URL'), 'postgres://u:p@h:5432/db?x=1')
  })

  test('an empty value is a value', () => {
    assert.equal(valueOf('EMPTY=', 'EMPTY'), '')
  })

  test('names that are not usable variable names are skipped with a reason', () => {
    const parsed = parseDotenv(['lower=x', '9START=x', 'has-dash=x', 'no equals here'].join('\n'))
    assert.equal(parsed.entries.length, 0)
    assert.equal(parsed.skipped.length, 4)
    assert.match(parsed.skipped[3]!.reason, /KEY=VALUE/)
  })

  test('a duplicated key keeps the last value and says so', () => {
    const parsed = parseDotenv(['PW=first', 'PW=second'].join('\n'))
    assert.deepEqual(
      parsed.entries.map((e) => e.value),
      ['second'],
      'a shell would use the last one'
    )
    assert.match(parsed.warnings[0]!, /appears more than once/)
  })

  test('line numbers point at the file, for the warnings to be useful', () => {
    const parsed = parseDotenv(['# note', '', 'KEY=value'].join('\n'))
    assert.equal(parsed.entries[0]!.line, 3)
  })

  test('CRLF files parse the same as LF', () => {
    assert.equal(valueOf('A=1\r\nB=2\r\n', 'B'), '2')
  })
})

describe('which keys a manifest calls secrets', () => {
  const manifest = `
fleet: homelab
services:
  postgres:
    image: postgres:15-alpine
    secrets: [POSTGRES_PASSWORD]
  api:
    build: ./api
    env:
      NODE_ENV: production
    secrets:
      - JWT_SECRET
      - DB_PASSWORD
  website:
    build: ./web
`

  test('collects every declared secret and who wants it', () => {
    const declared = declaredSecrets(manifest)
    assert.deepEqual([...declared.keys()].sort(), ['DB_PASSWORD', 'JWT_SECRET', 'POSTGRES_PASSWORD'])
    assert.deepEqual(declared.get('JWT_SECRET'), ['api'])
  })

  test('plain env is not a secret', () => {
    // This is the whole reason import filters by the manifest: a .env holds
    // NODE_ENV next to a password, and only one of them belongs in the store.
    assert.equal(declaredSecrets(manifest).has('NODE_ENV'), false)
  })

  test('one secret shared by two services lists both', () => {
    const shared = declaredSecrets(`
services:
  a: { secrets: [SHARED] }
  b: { secrets: [SHARED] }
`)
    assert.deepEqual(shared.get('SHARED'), ['a', 'b'])
  })

  test('a manifest with no services is empty, not an error', () => {
    assert.equal(declaredSecrets('fleet: homelab').size, 0)
    assert.equal(declaredSecrets('').size, 0)
  })
})
