// The core model a testing checkout runs on.
//
// `test/testing.json` names it once — DeepSeek 4.1 Flash through Pi, `pi:opencode-go/deepseek-v4.1-flash`
// — and `scripts/pre-go.mjs` injects it as TUCANO_TEST_MODEL, so a checkout, a seeded demo team and
// the two small jobs (who replies in a channel, and memory) all run on the same model.
//
// It matters because the machine these runs are verified on has no Claude subscription: a core of
// 'haiku' or a seeded agent on 'sonnet' is a model nobody there can call, and the app has nothing
// to say until someone notices. Unset, as on a real install, nothing changes: the app picks from
// what is signed in.
export function testingModel(env: NodeJS.ProcessEnv = process.env): string {
  return (env['TUCANO_TEST_MODEL'] ?? '').trim()
}

// What the app would have picked on its own, unless this is a testing checkout with its own model.
export const unlessTesting = (usual: string, env: NodeJS.ProcessEnv = process.env): string => testingModel(env) || usual
