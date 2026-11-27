// A driver of `lntt ci local`'s loaders (src/ci/asks.ts) for the specs: each ask answered from a
// record, the files as a map from their paths. Not published: tsconfig.build.json leaves
// src/testing/ out.

import type { Ask, Asks } from '../ci/asks.ts'
import type { Processed } from '../ci/circleci.ts'

export interface Answers {
  // The files, by their absolute paths; a directory is listed from them.
  files?: Record<string, string>
  onPath?: (command: string) => boolean
  node?: string
  changed?: (branch: string) => string[] | null
  process?: (ask: Extract<Ask, { kind: 'process' }>) => Processed
}

function answer(ask: Ask, answers: Answers): unknown {
  const files = answers.files ?? {}
  switch (ask.kind) {
    case 'read':
      return files[ask.path] ?? null
    case 'list': {
      const prefix = `${ask.dir}/`
      const names = Object.keys(files)
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length).split('/')[0] as string)
      return names.length > 0 ? [...new Set(names)] : null
    }
    case 'onPath':
      return answers.onPath?.(ask.command) ?? true
    case 'node':
      return answers.node ?? 'v24.0.0'
    case 'changed':
      return answers.changed?.(ask.branch) ?? null
    case 'process':
      if (!answers.process) throw new Error('no processor')
      return answers.process(ask)
    case 'await':
      return ask.promise()
  }
}

// Runs a loader to its end; what an answer throws is thrown into it. The asks it made are kept.
export async function drive<A>(steps: Asks<A>, answers: Answers = {}, asked: Ask[] = []): Promise<A> {
  let next = steps.next()
  while (!next.done) {
    asked.push(next.value)
    let result: unknown
    try {
      result = await answer(next.value, answers)
    } catch (error) {
      next = steps.throw(error)
      continue
    }
    next = steps.next(result)
  }
  return next.value
}
