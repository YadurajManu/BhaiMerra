import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs } from '../src/args.js'
import { table, relativeTime, mb, visibleLength, c } from '../src/render.js'

describe('argument parsing', () => {
  test('separates positionals from flags', () => {
    const { positional, flags } = parseArgs(['deploy', 'web', '--sha', '4f1c9ae'])
    assert.deepEqual(positional, ['deploy', 'web'])
    assert.equal(flags.sha, '4f1c9ae')
  })

  test('a flag with no value is boolean', () => {
    const { flags } = parseArgs(['nodes', '--json'])
    assert.equal(flags.json, true)
  })

  test('a trailing flag does not swallow the next command', () => {
    const { positional, flags } = parseArgs(['nodes', 'rm', 'pi5', '--force'])
    assert.deepEqual(positional, ['nodes', 'rm', 'pi5'])
    assert.equal(flags.force, true)
  })

  test('short and long forms both work', () => {
    assert.equal(parseArgs(['-h']).flags.h, true)
    assert.equal(parseArgs(['--help']).flags.help, true)
  })

  test('a flag value that looks like a path is kept', () => {
    assert.equal(parseArgs(['apply', '--fleet', 'abc-123']).flags.fleet, 'abc-123')
  })
})

describe('rendering', () => {
  test('columns align on visible width, ignoring colour codes', () => {
    // Counting escape bytes toward the width makes every column drift.
    const coloured = c.green('online')
    assert.equal(visibleLength(coloured), 'online'.length)

    const out = table(['a', 'b'], [[coloured, 'x'], ['offline', 'y']])
    const [, first, second] = out.split('\n')
    // Both rows should place column b at the same visible offset.
    assert.equal(
      visibleLength(first!.slice(0, first!.lastIndexOf('x'))),
      visibleLength(second!.slice(0, second!.lastIndexOf('y')))
    )
  })

  test('an empty table renders nothing rather than a lonely header', () => {
    assert.equal(table(['name', 'status'], []), '')
  })

  test('relative time works in both directions', () => {
    const past = new Date(Date.now() - 90_000).toISOString()
    const future = new Date(Date.now() + 600_000).toISOString()
    assert.match(relativeTime(past), /2m ago/)
    // A pairing token expires ahead of now; "-600s from now" is nonsense.
    assert.match(relativeTime(future), /10m from now/)
    assert.equal(relativeTime(null), 'never')
  })

  test('memory is shown in the unit a human would use', () => {
    assert.equal(mb(512), '512MB')
    assert.equal(mb(16384), '16.0GB')
  })
})
