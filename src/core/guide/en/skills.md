# Skills
> Recipes the agents follow for a kind of task: writing one, bringing one from Claude Code or Codex, approving the agents' proposals and going back to a version.

A skill is a recipe in Markdown for a kind of task: exact commands, pitfalls, how to check. Each agent sees, in its prompt, the name and the **When to use** of the skills that apply to it, and reads the recipe when it needs to.

## Creating one
1. Open **Skills** in the sidebar and click **New skill**.
2. **Name** (short; it becomes something like core-tests), **When to use** (one sentence that goes into every agent's prompt) and **Recipe** (the steps).
3. **Who uses it**: **Every agent** or **Only some**.
4. **Create skill**.

On the agent's page, the **Channels and skills** tab shows and changes the skills it uses.

## Bringing over the ones you already have
**Find existing skills** searches your Claude Code and Codex skills. **Use** brings one over: it is read straight from the file, so what you change there counts the next time. A skill with scripts only runs with an agent that has a computer (Linux or this computer). The introduction offers to bring yours over as well.

## The agents' proposals
When an agent solves something in several steps, gets out of a dead end or is corrected by you, it can propose a new skill or a change to one of its own. The proposal sits in **Proposals**, at the top of Skills, and only comes into use if you **Approve** it (or **Refuse**). Once approved, you can open it up to other agents.

## History and archiving
- Every change stays in the skill's **History**, with **Restore this one** to bring a version back.
- **How it's going** shows how the replies that used the skill ended.
- **Archive** takes it out of use and keeps it in **Archived** (with **Reactivate**). **Delete** removes it for good.

## When it goes wrong
- The agent does not use the skill: check under **Who uses it** that it is included, and that the **When to use** describes the situation well.
- A skill with scripts failing: the agent needs a computer (see **computadores**).
