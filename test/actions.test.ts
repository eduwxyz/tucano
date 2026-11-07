import { describe, expect, it } from 'vitest'
import { actionMode, cleanRules, gate, policyOf, shellActions, simpleCommands, toolActions, verdict, type Policy } from '../src/shared/actions'

describe('shellActions', () => {
  it('finds the git actions that matter', () => {
    expect(shellActions('git commit -m "first"')).toEqual(['commit'])
    expect(shellActions('git push origin agent/x')).toEqual(['push'])
    expect(shellActions('git merge feature')).toEqual(['merge'])
    expect(shellActions('git status && git diff && git log --oneline -5')).toEqual([])
    expect(shellActions('git add . && git checkout -b agent/x')).toEqual([])
  })

  it('reads every command of the line, once each, in order', () => {
    expect(shellActions('git add -A && git commit -m wip && git push -u origin HEAD')).toEqual(['commit', 'push'])
    expect(shellActions('git commit -m a; git commit -m b')).toEqual(['commit'])
    expect(shellActions('cd /projetos/app\ngit push')).toEqual(['push'])
    expect(shellActions('(cd repo && git push)')).toEqual(['push'])
    expect(shellActions('npm test || git push')).toEqual(['push'])
  })

  it("skips git's own options before the subcommand", () => {
    expect(shellActions('git -C /projetos/app -c user.name=Lia commit -m x')).toEqual(['commit'])
    expect(shellActions('git --no-pager push')).toEqual(['push'])
  })

  it('looks through wrappers, env assignments and nested shells', () => {
    expect(shellActions('GIT_AUTHOR_NAME=Lia git commit -m x')).toEqual(['commit'])
    expect(shellActions('sudo -u lia git push')).toEqual(['push'])
    expect(shellActions('timeout 30 git push')).toEqual(['push'])
    expect(shellActions(`bash -lc 'git push origin main'`)).toEqual(['push'])
    expect(shellActions(`sh -c "cd x && git commit -m 'y'"`)).toEqual(['commit'])
    expect(shellActions('eval "git push"')).toEqual(['push'])
    expect(shellActions('echo $(git push)')).toEqual(['push'])
    expect(shellActions('echo "pushed: $(git push 2>&1)"')).toEqual(['push'])
    expect(shellActions('echo `git commit -m x`')).toEqual(['commit'])
    expect(shellActions('/usr/bin/git push')).toEqual(['push'])
  })

  it('does not read quoted text as commands', () => {
    expect(shellActions('git commit -m "rm -rf everything; git push"')).toEqual(['commit'])
    expect(shellActions(`echo 'git push'`)).toEqual([])
    expect(shellActions('grep -r "git commit" docs')).toEqual([])
    expect(shellActions('# git push later\nls')).toEqual([])
  })

  it('opens and merges PRs from the command line', () => {
    expect(shellActions('gh pr create --title x --body y')).toEqual(['pr'])
    expect(shellActions('gh pr merge 12 --squash')).toEqual(['merge'])
    expect(shellActions('gh pr view 12 && gh pr list')).toEqual([])
    expect(shellActions('glab mr create')).toEqual(['pr'])
    expect(shellActions('hub pull-request -m x')).toEqual(['pr'])
    expect(shellActions('git merge --abort')).toEqual([])
  })

  it('knows deleting', () => {
    expect(shellActions('rm -rf /projetos/app/src')).toEqual(['delete'])
    expect(shellActions('rm -r docs')).toEqual(['delete'])
    expect(shellActions('rm --recursive docs')).toEqual(['delete'])
    expect(shellActions('rm notes.txt')).toEqual([])
    expect(shellActions('rm -rf node_modules dist')).toEqual([]) // a build makes them again
    expect(shellActions('rm -rf node_modules src')).toEqual(['delete'])
    expect(shellActions('git branch -D agent/old')).toEqual(['delete'])
    expect(shellActions('git branch --delete agent/old')).toEqual(['delete'])
    expect(shellActions('git branch -a')).toEqual([])
    expect(shellActions('git reset --hard HEAD~1')).toEqual(['delete'])
    expect(shellActions('git reset HEAD~1')).toEqual([])
    expect(shellActions('git clean -fdx')).toEqual(['delete'])
    expect(shellActions('git clean -n')).toEqual([])
    expect(shellActions('git stash drop')).toEqual(['delete'])
    expect(shellActions('git push origin --delete agent/old')).toEqual(['push', 'delete'])
    expect(shellActions('git push origin :agent/old')).toEqual(['push', 'delete'])
    expect(shellActions('find . -name "*.log" -delete')).toEqual(['delete'])
    expect(shellActions('gh repo delete me/x --yes')).toEqual(['delete'])
  })

  it('knows publishing', () => {
    expect(shellActions('npm publish --access public')).toEqual(['publish'])
    expect(shellActions('cargo publish')).toEqual(['publish'])
    expect(shellActions('docker push me/app:1')).toEqual(['publish'])
    expect(shellActions('vercel --prod')).toEqual(['publish'])
    expect(shellActions('npx vercel')).toEqual([])
    expect(shellActions('fly deploy')).toEqual(['publish'])
    expect(shellActions('gh release create v1.0.0')).toEqual(['publish'])
    expect(shellActions('npm install && npm run build')).toEqual([])
  })
})

describe('simpleCommands', () => {
  it('splits on operators and keeps quoted words whole', () => {
    expect(simpleCommands(`a 'b c' && d "e f"|g;h`)).toEqual([['a', 'b c'], ['d', 'e f'], ['g'], ['h']])
  })
  it('treats redirections as word breaks', () => {
    expect(simpleCommands('git push >out.txt 2>&1')).toEqual([['git', 'push', 'out.txt', '2'], ['1']])
  })
})

describe('toolActions', () => {
  it('reads a connector tool by its name', () => {
    expect(toolActions('create_pull_request')).toEqual(['pr'])
    expect(toolActions('createPullRequest')).toEqual(['pr'])
    expect(toolActions('merge_pull_request')).toEqual(['merge'])
    expect(toolActions('push_files')).toEqual(['push'])
    expect(toolActions('delete_task')).toEqual(['delete'])
    expect(toolActions('send_email')).toEqual(['send'])
    expect(toolActions('chat_postMessage')).toEqual(['send'])
    expect(toolActions('deploy_service')).toEqual(['publish'])
    expect(toolActions('create_payment')).toEqual(['pay'])
    expect(toolActions('create_issue')).toEqual([])
    expect(toolActions('update_pull_request')).toEqual([])
  })
  it('does not match words inside other words', () => {
    expect(toolActions('resend_invite')).toEqual([])
    expect(toolActions('update_prompt')).toEqual([])
  })
})

describe('rules', () => {
  it('out of the box no rule decides: the tool says, as before levels', () => {
    expect(actionMode('commit', {})).toBeUndefined()
    expect(actionMode('commit', { globalLevel: 'careful' })).toBe('ask')
    expect(actionMode('commit', { globalLevel: 'free' })).toBe('auto')
  })

  it("the agent's rule, then its own level, then Settings' rule, then Settings' level", () => {
    expect(actionMode('commit', { globalRules: { commit: 'auto' } })).toBe('auto')
    expect(actionMode('commit', { agentRules: { commit: 'ask' }, globalRules: { commit: 'auto' } })).toBe('ask')
    expect(actionMode('push', { agentRules: { commit: 'auto' }, globalRules: { push: 'off' } })).toBe('off')
    expect(actionMode('push', { agentLevel: 'free', globalRules: { push: 'off' } })).toBe('auto')
    expect(actionMode('push', { agentLevel: 'normal', globalRules: { push: 'off' }, globalLevel: 'free' })).toBe('off')
    expect(actionMode('push', { agentLevel: 'normal', globalLevel: 'free' })).toBeUndefined()
  })

  it('stops a call when any of its kinds is never, else waits when any asks, and runs alone only when all say so', () => {
    expect(gate(['commit', 'push'], { globalRules: { commit: 'auto' }, globalLevel: 'careful' })).toEqual({ mode: 'ask', kinds: ['push'] })
    expect(gate(['commit', 'push'], { agentRules: { push: 'off' } })).toEqual({ mode: 'off', kinds: ['push'] })
    expect(gate(['commit', 'push'], { agentRules: { commit: 'auto', push: 'auto' } })).toEqual({ mode: 'auto', kinds: ['commit', 'push'] })
    expect(gate(['commit', 'push'], { agentRules: { commit: 'auto' } })).toEqual({ kinds: ['push'] })
    expect(gate([], {})).toEqual({ kinds: [] })
  })

  it('reads the policy off an agent and Settings, with the guard on unless someone turned it off', () => {
    expect(policyOf(undefined, {}).guard).toBe(true)
    expect(policyOf({ outsideGuard: false }, { outsideGuard: true }).guard).toBe(false)
    expect(policyOf({}, { outsideGuard: false }).guard).toBe(false)
  })
  it('keeps only known kinds and modes', () => {
    expect(cleanRules({ commit: 'auto', push: 'maybe', rm: 'off', pr: 'off' })).toEqual({ commit: 'auto', pr: 'off' })
    expect(cleanRules(null)).toEqual({})
    expect(cleanRules('x')).toEqual({})
  })
})

describe('what happens to a call', () => {
  const normal: Policy = { guard: true }
  const careful: Policy = { globalLevel: 'careful', guard: true }
  const free: Policy = { globalLevel: 'free', guard: true }
  const v = (o: Partial<Parameters<typeof verdict>[0]>) => verdict({ cls: 'write', kinds: [], p: normal, ...o })

  it('normal is how Tucano always worked', () => {
    expect(v({ cls: 'read' }).run).toBe(true)
    expect(v({ cls: 'write' }).run).toBe(true)
    expect(v({ cls: 'sensitive', kinds: ['delete'] })).toMatchObject({ run: false, why: 'class' })
    expect(v({ cls: 'sensitive', kinds: ['delete'], alwaysAllowed: true })).toMatchObject({ run: true, why: 'always' })
    expect(v({ askByDefault: true, kinds: ['browser'] })).toMatchObject({ run: false })
  })

  it('careful asks before any change, even one approved for good, and still reads freely', () => {
    expect(v({ p: careful, cls: 'read' }).run).toBe(true)
    expect(v({ p: careful, cls: 'write' })).toMatchObject({ run: false, why: 'level' })
    expect(v({ p: careful, cls: 'sensitive', kinds: ['send'], alwaysAllowed: true })).toMatchObject({ run: false })
  })

  it('no guardrails runs everything, but never what is high risk or turned off', () => {
    expect(v({ p: free, cls: 'sensitive', kinds: ['delete'] }).run).toBe(true)
    expect(v({ p: free, cls: 'sensitive' }).run).toBe(true)
    expect(v({ p: free, askByDefault: true, kinds: ['browser'] }).run).toBe(true)
    expect(v({ p: free, cls: 'sensitive', kinds: ['delete'], highRisk: true })).toMatchObject({ run: false, why: 'risk' })
    expect(v({ p: { ...free, agentRules: { pay: 'off' } }, cls: 'sensitive', kinds: ['pay'] })).toMatchObject({ run: false, off: true })
  })

  it('after something from outside, the guard asks before what goes out or cannot be undone, and only that', () => {
    expect(v({ p: free, cls: 'sensitive', kinds: ['send'], outside: true })).toMatchObject({ run: false, why: 'guard' })
    expect(v({ p: free, cls: 'sensitive', kinds: ['delete'], outside: true })).toMatchObject({ run: false, why: 'guard' })
    expect(v({ p: free, cls: 'sensitive', outside: true })).toMatchObject({ run: false, why: 'guard' })
    expect(v({ p: free, cls: 'write', kinds: ['commit'], outside: true }).run).toBe(true)
    expect(v({ p: { ...normal, agentRules: { send: 'auto' } }, cls: 'sensitive', kinds: ['send'], outside: true })).toMatchObject({ run: false, why: 'guard' })
    expect(v({ p: { ...free, guard: false }, cls: 'sensitive', kinds: ['send'], outside: true }).run).toBe(true)
  })
})
