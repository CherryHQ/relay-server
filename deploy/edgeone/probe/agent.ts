import { EdgeOneProbe } from '../../../src/edgeone/probe.js'

const probe = new EdgeOneProbe('agent')

// Experimental: the cloud callback return value is NOT assumed to work in Agents.
// A JSON 200 response or failed upgrade must fail check:edgeone-probe.
export function onRequest(context: {
  request: { url: string; method: string; headers: Record<string, string> }
}) {
  // AgentContextRequest is a plain object, unlike Cloud Functions' Web Request.
  return probe.handle({ ...context.request, headers: new Headers(context.request.headers) })
}
