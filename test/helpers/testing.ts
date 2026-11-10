// What a test run is set up with, in one place: the model behind the two small jobs (who
// replies in a channel, and memory), and whether a model is a Claude one.
//
// A fixture must not seed a Claude model as the core: the machine these tests are verified on
// has no Claude subscription, so `routerModel: 'haiku'` is a fixture that assumes something the
// instance doesn't have. `TEST_CORE_MODEL` is DeepSeek 4.1 Flash through Pi's `opencode-go`
// provider, which is what that machine actually runs. test/testing-setup.test.ts keeps it out.
import setup from '../testing.json'

// The value a fixture writes into `routerModel` and `memoryModel`.
export const TEST_CORE_MODEL: string = setup.coreModel

// How it reads on screen, for a test that has to show it.
export const TEST_CORE_MODEL_LABEL: string = setup.coreModelLabel

// The Claude ids the app lists, and any custom name kept as "claude:<name>".
export const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku']
export const isClaudeModel = (id: string): boolean => CLAUDE_MODELS.includes(id) || id.startsWith('claude:')
