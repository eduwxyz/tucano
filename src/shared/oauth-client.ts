// How Tucano describes itself to a connector's authorization server. A server that registers apps on
// the fly (most) gets it in the registration; one that takes no registration but reads a client's
// description from an https address of its own (ElevenLabs: "client ID metadata documents") reads the
// same thing there, with that address as the client_id.
export const CLIENT_METADATA_PATH = '/oauth/client.json'

export interface TucanoClientMetadata {
  client_name: string
  redirect_uris: string[]
  grant_types: string[]
  response_types: string[]
  token_endpoint_auth_method: 'none'
}

export const tucanoClientMetadata = (redirectUrl: string): TucanoClientMetadata => ({
  client_name: 'Tucano',
  redirect_uris: [redirectUrl],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none'
})

// The document served at CLIENT_METADATA_PATH: the description, under the address it's served from.
// Only what any sign-in page already shows: the name and where the sign-in comes back.
export const clientMetadataDocument = (publicUrl: string): TucanoClientMetadata & { client_id: string } => ({
  client_id: `${publicUrl}${CLIENT_METADATA_PATH}`,
  ...tucanoClientMetadata(`${publicUrl}/oauth/callback`)
})
