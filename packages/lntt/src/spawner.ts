// Effect's ChildProcessSpawner on Node, which resolves a working directory through the file system
// and the path services: what the live layers of lntt's services over a process run on (Git, Gh,
// the agents).

import * as NodeChildProcessSpawner from '@effect/platform-node-shared/NodeChildProcessSpawner'
import * as NodeFileSystem from '@effect/platform-node-shared/NodeFileSystem'
import * as NodePath from '@effect/platform-node-shared/NodePath'
import * as Layer from 'effect/Layer'

export const SpawnerLive = NodeChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)
