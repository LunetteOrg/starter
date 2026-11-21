// A clone in memory, for the specs of the modules that ask git about refs and history (the base,
// lntt branch): commits with their parents, refs by full name, HEAD on a branch or detached. Its
// layer answers the Git operations those modules use as git would on such a clone.

import * as Effect from 'effect/Effect'
import { Git, GitError } from '../git/git.ts'

export function repository() {
  const parents = new Map<string, string[]>()
  const refs = new Map<string, string>()
  let head: { branch: string } | { detached: string } = { branch: 'main' }
  let originHead: string | null = null
  let renamed: string[] = []
  // A git that cannot list the refs: pointingAt fails as git would.
  let refsUnreadable = false
  // A git whose merge-base fails for a reason other than "no common history".
  let mergeBaseBroken = false

  // The commit a revision names, as `git rev-parse --verify` resolves it; null for none.
  const resolve = (rev: string): string | null => {
    const name = rev.replace(/\^\{commit\}$/, '')
    if (name === 'HEAD') return 'detached' in head ? head.detached : (refs.get(`refs/heads/${head.branch}`) ?? null)
    if (name.startsWith('refs/')) return refs.get(name) ?? null
    return (
      refs.get(`refs/heads/${name}`) ?? refs.get(`refs/remotes/${name}`) ?? (parents.has(name) ? name : null) ?? null
    )
  }
  // A commit and every commit it descends from, nearest first.
  const ancestors = (id: string | null): string[] => {
    const seen: string[] = []
    const queue = id === null ? [] : [id]
    while (queue.length > 0) {
      const next = queue.shift() as string
      if (seen.includes(next)) continue
      seen.push(next)
      queue.push(...(parents.get(next) ?? []))
    }
    return seen
  }

  const repo = {
    // A commit on HEAD (or on `parent`), with HEAD's branch moved to it; its id.
    commit(id: string, parent: string | null = resolve('HEAD')) {
      parents.set(id, parent === null ? [] : [parent])
      if (!('detached' in head)) refs.set(`refs/heads/${head.branch}`, id)
      else head = { detached: id }
      return id
    },
    // Points a ref (`refs/remotes/origin/main`) at a revision; null deletes it.
    ref(name: string, rev: string | null) {
      if (rev === null) refs.delete(name)
      else refs.set(name, resolve(rev) as string)
    },
    // Switches to a branch, created at `from` when given.
    switch(branch: string, from?: string) {
      if (from !== undefined) refs.set(`refs/heads/${branch}`, resolve(from) as string)
      head = { branch }
    },
    detach(rev: string) {
      head = { detached: resolve(rev) as string }
    },
    // What origin/HEAD points at (`origin/main`), null for none.
    originHead(name: string | null) {
      originHead = name
    },
    unreadableRefs() {
      refsUnreadable = true
    },
    // merge-base fails as git does on a revision it does not know (exit 128), not as it does on
    // histories with nothing in common (exit 1).
    brokenMergeBase() {
      mergeBaseBroken = true
    },
    current: () => ('detached' in head ? '' : head.branch),
    resolve,
    renamed: () => renamed,
    layer: () =>
      Git.memory({
        current: Effect.sync(() => repo.current()),
        branch: Effect.sync(() => repo.current() || 'HEAD'),
        verify: (rev) => Effect.sync(() => resolve(rev)),
        originHead: Effect.sync(() => originHead),
        pointingAt: (rev, pattern) =>
          refsUnreadable
            ? Effect.fail(new GitError({ args: ['for-each-ref'], output: 'fatal: bad object' }))
            : Effect.sync(() => {
                const at = resolve(rev)
                const prefix = pattern.replace(/\*$/, '')
                return [...refs].filter(([name, id]) => id === at && name.startsWith(prefix)).map(([name]) => name)
              }),
        mergeBase: (a, b) =>
          Effect.suspend(() => {
            if (mergeBaseBroken) {
              return Effect.fail(
                new GitError({ args: ['merge-base', a, b], output: `fatal: Not a valid object name ${b}`, code: 128 }),
              )
            }
            const of = ancestors(resolve(b))
            const common = ancestors(resolve(a)).find((id) => of.includes(id))
            return common === undefined
              ? Effect.fail(new GitError({ args: ['merge-base', a, b], output: '', code: 1 }))
              : Effect.succeed(common)
          }),
        isAncestor: (a, b) => Effect.sync(() => ancestors(resolve(b)).includes(resolve(a) as string)),
        renameBranch: (name) =>
          Effect.sync(() => {
            if ('detached' in head) return
            const id = refs.get(`refs/heads/${head.branch}`) as string
            refs.delete(`refs/heads/${head.branch}`)
            refs.set(`refs/heads/${name}`, id)
            renamed = [...renamed, `${head.branch} → ${name}`]
            head = { branch: name }
          }),
      }),
  }
  return repo
}

// The clone a branch's base sees, as test/clone.ts builds it on disk: origin/main ahead of the
// local main, which is stale, and an open candidate (origin/candidate/13) one commit ahead of
// origin/main; HEAD on main.
export function clone() {
  const repo = repository()
  const stale = repo.commit('c-stale', null)
  repo.ref('refs/remotes/origin/main', stale)
  const main = repo.commit('c-main')
  repo.ref('refs/remotes/origin/main', main)
  const candidate = repo.commit('c-candidate')
  repo.ref('refs/remotes/origin/candidate/13', candidate)
  repo.ref('refs/heads/main', stale)
  repo.originHead('origin/main')
  return Object.assign(repo, { stale, main, candidate })
}
