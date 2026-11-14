import { describe, expect, it } from 'vitest'
import { readsClientDocuments } from '../src/core/connectors'
import { CLIENT_METADATA_PATH, clientMetadataDocument, tucanoClientMetadata } from '../src/shared/oauth-client'

// A fetch that answers the well-known addresses from a table, and 404 for the rest.
const fake =
  (routes: Record<string, unknown>): typeof fetch =>
  async (input) => {
    const url = String(input instanceof Request ? input.url : input)
    const body = routes[url]
    return body === undefined ? new Response('not found', { status: 404 }) : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }

describe("a client metadata document (the sign-in of servers that take no registration)", () => {
  it('describes this Tucano under the address it is served from, and nothing more', () => {
    const doc = clientMetadataDocument('https://ana.example.com')
    expect(doc).toEqual({
      client_id: `https://ana.example.com${CLIENT_METADATA_PATH}`,
      client_name: 'Tucano',
      redirect_uris: ['https://ana.example.com/oauth/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    })
    // The same description a registration sends.
    const { client_id: _id, ...described } = doc
    expect(tucanoClientMetadata('https://ana.example.com/oauth/callback')).toEqual(described)
  })

  it('knows a server whose authorization server reads such documents', async () => {
    const as = 'https://auth.example.com'
    const routes = {
      'https://mcp.example.com/.well-known/oauth-protected-resource/v1/mcp': { resource: 'https://mcp.example.com/v1/mcp', authorization_servers: [as] },
      [`${as}/.well-known/oauth-authorization-server`]: {
        issuer: as,
        authorization_endpoint: `${as}/authorize`,
        token_endpoint: `${as}/token`,
        response_types_supported: ['code'],
        client_id_metadata_document_supported: true
      }
    }
    expect(await readsClientDocuments('https://mcp.example.com/v1/mcp', fake(routes))).toBe(true)
  })

  it("doesn't take a server that only registers apps for one", async () => {
    const routes = {
      'https://mcp.example.com/.well-known/oauth-authorization-server': {
        issuer: 'https://mcp.example.com',
        authorization_endpoint: 'https://mcp.example.com/authorize',
        token_endpoint: 'https://mcp.example.com/token',
        registration_endpoint: 'https://mcp.example.com/register',
        response_types_supported: ['code']
      }
    }
    expect(await readsClientDocuments('https://mcp.example.com/mcp', fake(routes))).toBe(false)
  })
})
