import { EdgeOneProbe } from '../../../src/edgeone/probe.js'

const probe = new EdgeOneProbe('cloud')

export function onRequest(context: { request: Request }) {
  return probe.handle(context.request)
}
