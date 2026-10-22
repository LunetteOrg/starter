import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { configDefaults } from 'vitest/config'
import { appTest, JSDOM_SETUP_FILE, sharedCoverage, sharedReporters, sharedTest } from './vitest.ts'

describe('sharedTest', () => {
  it('undoes every stub and spy after each test and writes the JUnit file', () => {
    const test = sharedTest()
    expect(test).toMatchObject({ unstubGlobals: true, unstubEnvs: true, restoreMocks: true })
    expect(test.reporters).toEqual(['default', 'junit'])
    expect(test.outputFile).toEqual({ junit: 'test-results/junit.xml' })
    expect(sharedReporters).toEqual({ reporters: test.reporters, outputFile: test.outputFile })
  })

  it('measures coverage on the sources it is given, src by default, tests excluded', () => {
    expect(sharedTest().coverage).toMatchObject({ ...sharedCoverage, include: ['src/**/*.{ts,tsx}'] })
    expect(sharedTest({ sources: 'lib' }).coverage.include).toEqual(['lib/**/*.{ts,tsx}'])
    expect(sharedCoverage).toMatchObject({ provider: 'v8', reportsDirectory: './coverage' })
    expect(sharedCoverage.exclude).toEqual(expect.arrayContaining(['**/*.spec.{ts,tsx}', '**/*.test.{ts,tsx}']))
  })

  it('sets no isolate and no pool: a node-only package keeps vitest’s isolation', () => {
    expect(sharedTest()).not.toHaveProperty('isolate')
    expect(sharedTest()).not.toHaveProperty('pool')
  })
})

describe('appTest', () => {
  it('runs the files in a fast project, on threads, sharing the module registry', () => {
    const test = appTest()
    expect(test.projects).toHaveLength(1)
    expect(test.projects[0]).toEqual({
      extends: true,
      test: {
        name: 'fast',
        exclude: [...configDefaults.exclude, '**/.react-router/**', '**/build/**', '**/e2e/**'],
        pool: 'threads',
        isolate: false,
      },
    })
  })

  it('starts from sharedTest on the app directory', () => {
    const test = appTest()
    expect(test).toMatchObject({ unstubGlobals: true, unstubEnvs: true, restoreMocks: true })
    expect(test.coverage.include).toEqual(['app/**/*.{ts,tsx}'])
    expect(appTest({ sources: 'src' }).coverage.include).toEqual(['src/**/*.{ts,tsx}'])
  })

  it('lists the jsdom setup itself, last, after the setup files it is given', () => {
    expect(appTest().setupFiles).toEqual([JSDOM_SETUP_FILE])
    expect(appTest({ setupFiles: ['@testing-library/jest-dom/vitest'] }).setupFiles).toEqual([
      '@testing-library/jest-dom/vitest',
      JSDOM_SETUP_FILE,
    ])
    const { exports } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(exports['./jsdom-setup']).toEqual({ types: './dist/jsdom-setup.d.ts', default: './dist/jsdom-setup.js' })
  })

  it('puts the heavy specs in a project of their own, ordered after the others', () => {
    const test = appTest({ last: { name: 'dev-server', include: ['vite-deps.test.ts'] }, exclude: ['built/**'] })
    const exclude = [...configDefaults.exclude, '**/.react-router/**', '**/build/**', '**/e2e/**', 'built/**']
    expect(test.projects).toEqual([
      {
        extends: true,
        test: { name: 'fast', exclude: [...exclude, 'vite-deps.test.ts'], pool: 'threads', isolate: false },
      },
      {
        extends: true,
        test: { name: 'dev-server', include: ['vite-deps.test.ts'], exclude, sequence: { groupOrder: 1 } },
      },
    ])
  })

  it('refuses a heavy project with nothing to include', () => {
    expect(() => appTest({ last: { name: 'dev-server', include: [] } })).toThrow(/include/)
  })

  it('refuses the jsdom setup listed twice, by name or by path', () => {
    for (const listed of [
      '@lntt/test-utils/jsdom-setup',
      './node_modules/@lntt/test-utils/dist/jsdom-setup.js',
      '../../packages/test-utils/src/jsdom-setup.ts',
    ]) {
      expect(() => appTest({ setupFiles: [listed] }), listed).toThrow(
        `appTest() lists @lntt/test-utils/jsdom-setup itself: remove ${listed} from its setupFiles.`,
      )
    }
  })

  it('accepts an app setup file that is only named like it', () => {
    for (const own of [
      './test/jsdom-setup.ts',
      './jsdom-setup.ts',
      './my-jsdom-setup.ts',
      '@acme/test-utils/jsdom-setup',
    ]) {
      expect(appTest({ setupFiles: [own] }).setupFiles, own).toEqual([own, JSDOM_SETUP_FILE])
    }
  })
})
